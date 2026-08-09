// char_creator.js — 2-Slot Account Manager, Character Creator & Character Select UI
import { RACES, STARTING_STAT_POINTS, BASE_STAT_MIN, BASE_STAT_MAX } from './constants.js';
import { player, inv, bank, skills, G } from './state.js';

const ACCOUNT_KEY = 'bravo_account_v1';
const LEGACY_KEY = 'medievalSave_v06';

// ── Account Manager (2 Character Slots) ──────────────────────────────────
export const AccountManager = {
  getAccount() {
    try {
      const raw = localStorage.getItem(ACCOUNT_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}

    // Auto-migrate legacy single save into Slot 0 if available
    const acc = { activeSlot: 0, slots: [null, null] };
    try {
      const legacyRaw = localStorage.getItem(LEGACY_KEY);
      if (legacyRaw) {
        const legacySave = JSON.parse(legacyRaw);
        acc.slots[0] = {
          id: 'slot_0',
          name: legacySave.name || localStorage.getItem('bravoName') || 'Traveler',
          gender: legacySave.gender || (legacySave.dollGender === 'f' ? 'female' : 'male'),
          race: legacySave.race || 'Human',
          stats: legacySave.stats || { str: 10, dex: 10, int: 10, vit: 10 },
          saveBlob: legacySave,
          createdAt: Date.now(),
        };
      }
    } catch (e) {
      console.warn('[AccountManager] Legacy migration failed:', e);
    }
    this.saveAccount(acc);
    return acc;
  },

  // Make sure a character the SERVER says we own has a slot to click on.
  // On a new machine the local slot list is empty, so without this the select
  // screen offers only "create", and creating a character you already own used
  // to push a fresh save over the server's copy of it. The slot carries no
  // saveBlob on purpose: picking it joins the world under that name and the
  // server answers with the real save (net.onSave), which is the copy that
  // actually has your items.
  ensureSlotForName(name) {
    if (!name) return;
    const acc = this.getAccount();
    if (!acc) return;
    if (acc.slots.some(s => s && s.name === name)) return;   // already listed
    let idx = acc.slots.findIndex(s => !s);
    if (idx === -1) { acc.slots.push(null); idx = acc.slots.length - 1; }
    acc.slots[idx] = {
      id: 'slot_' + idx, name,
      gender: 'male', race: 'Human',
      stats: { str: 10, dex: 10, int: 10, vit: 10 },
      saveBlob: null,                       // ← filled from the server on join
      fromServer: true,
      createdAt: Date.now(),
    };
    this.saveAccount(acc);
  },

  saveAccount(acc) {
    try {
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(acc));
    } catch (e) {
      console.error('[AccountManager] Failed to save account:', e);
    }
  },

  getActiveSlotIndex() {
    const acc = this.getAccount();
    return (acc && acc.activeSlot !== undefined) ? acc.activeSlot : 0;
  },

  setActiveSlotIndex(idx) {
    const acc = this.getAccount();
    if (acc) {
      acc.activeSlot = idx;
      this.saveAccount(acc);
    }
  },

  getActiveSlot() {
    const acc = this.getAccount();
    return (acc && acc.slots && acc.slots[acc.activeSlot]) || null;
  },

  saveCurrentSlot(saveBlob, charDetails = {}) {
    const acc = this.getAccount();
    const idx = acc.activeSlot;
    const existing = acc.slots[idx] || {};

    acc.slots[idx] = {
      id: 'slot_' + idx,
      name: charDetails.name || player.name || existing.name || 'Traveler',
      gender: charDetails.gender || player.gender || existing.gender || 'male',
      race: charDetails.race || player.race || existing.race || 'Human',
      stats: charDetails.stats || (player.stats ? { ...player.stats } : (existing.stats || { str: 10, dex: 10, int: 10, vit: 10 })),
      saveBlob: saveBlob,
      updatedAt: Date.now(),
      createdAt: existing.createdAt || Date.now(),
    };
    this.saveAccount(acc);
  },

  deleteSlot(idx) {
    const acc = this.getAccount();
    if (idx >= 0 && idx < 2) {
      acc.slots[idx] = null;
      // Point the account at a slot that still exists, so getActiveSlot()
      // can't keep returning the deleted one.
      if (acc.activeSlot === idx) acc.activeSlot = acc.slots[0] ? 0 : (acc.slots[1] ? 1 : 0);
      this.saveAccount(acc);
      // Drop the legacy single-save too. loadGame() falls back to it when a
      // slot has no blob, which is how a "deleted" character used to come
      // straight back on the next boot.
      try { localStorage.removeItem(LEGACY_KEY); } catch (_) {}
    }
  }
};

// ── Random Name Generator ──────────────────────────────────────────────────
const MALE_NAMES = ['Thorin', 'Valerius', 'Grom', 'Lucian', 'Cassian', 'Kaelen', 'Drakar', 'Baelor', 'Gideon', 'Roderick'];
const FEMALE_NAMES = ['Lyra', 'Vespera', 'Aria', 'Selene', 'Freya', 'Elara', 'Nyssa', 'Morrigan', 'Elysia', 'Zephyra'];
const SURNAMES = ['Stonecleaver', 'Nightshade', 'Bloodfang', 'Starling', 'Shadowweaver', 'Ironheart', 'Stormwind', 'Frostbane', 'Duskrunner', 'Grimward'];

export function generateRandomName(gender = 'male') {
  const list = gender === 'female' ? FEMALE_NAMES : MALE_NAMES;
  const first = list[Math.floor(Math.random() * list.length)];
  const last = SURNAMES[Math.floor(Math.random() * SURNAMES.length)];
  return `${first} ${last}`;
}

// ── Creator State ─────────────────────────────────────────────────────────
export const creatorState = {
  slotIdx: 0,
  name: 'Traveler',
  gender: 'male',
  race: 'Human',
  stats: { str: 10, dex: 10, int: 10, vit: 10 },
  pointsLeft: STARTING_STAT_POINTS,
};

let nameInputElement = null;

function ensureNameInput() {
  if (!nameInputElement) {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 16;
    input.style.position = 'fixed';
    input.style.zIndex = '99999';
    input.style.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
    input.style.background = '#120d09';
    input.style.color = '#e8dcc0';
    input.style.border = '1.5px solid #c8a25a';
    input.style.borderRadius = '4px';
    input.style.padding = '4px 8px';
    input.style.display = 'none';
    input.addEventListener('input', (e) => {
      creatorState.name = e.target.value;
    });
    document.body.appendChild(input);
    nameInputElement = input;
  }
  return nameInputElement;
}

export function hideNameInput() {
  if (nameInputElement) nameInputElement.style.display = 'none';
}

export function openCreator(slotIdx) {
  creatorState.slotIdx = slotIdx;
  creatorState.gender = 'male';
  creatorState.race = 'Human';
  creatorState.stats = { str: 10, dex: 10, int: 10, vit: 10 };
  creatorState.pointsLeft = STARTING_STAT_POINTS;
  creatorState.name = generateRandomName('male');
  G.charCreatorOpen = true;
  G.charSelectOpen = false;
}

// ── Hitbox Registry for Canvas Clicking ───────────────────────────────────
let charSelectHits = [];
let charCreatorHits = [];

// ── Render Character Select Screen ────────────────────────────────────────
export function renderCharSelect(ctx, canvas, onSelectSlot, onCreateSlot) {
  hideNameInput();
  charSelectHits = [];

  const vw = (canvas && canvas.width) ? canvas.width : (window.innerWidth || 800);
  const vh = (canvas && canvas.height) ? canvas.height : (window.innerHeight || 600);

  // Dark overlay across the real viewport (drawn before the scale transform)
  ctx.fillStyle = 'rgba(10, 8, 6, 0.94)';
  ctx.fillRect(0, 0, vw, vh);

  // ── Scale-to-fit ────────────────────────────────────────────────────
  // The card layout below is authored at a fixed design size, then uniformly
  // scaled to the viewport. Phones get a portrait design (cards stacked) so
  // text stays legible instead of being squeezed into two narrow columns.
  const portrait = vw < vh;
  const DESIGN_W = portrait ? 420 : 820;
  const DESIGN_H = portrait ? 640 : 620;
  const S = Math.min(vw / DESIGN_W, vh / DESIGN_H);
  const offX = (vw - DESIGN_W * S) / 2;
  const offY = (vh - DESIGN_H * S) / 2;
  ctx.save();
  ctx.translate(offX, offY);
  ctx.scale(S, S);
  // Everything from here draws in design space.
  const w = DESIGN_W, h = DESIGN_H;

  // Decorative header
  const headerY = Math.max(30, Math.floor(h * 0.08));
  ctx.fillStyle = '#c8a25a';
  ctx.font = 'bold 24px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('PROJECT BRAVO — CHARACTER SELECTION', w / 2, headerY);

  ctx.fillStyle = '#a09070';
  ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText('Choose a character to enter Lunar, or create a new hero', w / 2, headerY + 22);

  const acc = AccountManager.getAccount();
  const gap = portrait ? 20 : 30;
  // Portrait stacks the two slots; landscape keeps them side by side.
  const cardW = portrait ? Math.floor(w - 40) : Math.min(340, Math.floor(w * 0.42));
  const cardH = portrait ? Math.floor((h - headerY - 90 - gap) / 2) : Math.min(420, Math.floor(h * 0.65));
  const cardY0 = headerY + 50;
  const startX = portrait ? 20 : (w - (cardW * 2 + gap)) / 2;

  for (let i = 0; i < 2; i++) {
    const slot = acc.slots[i];
    const cx = portrait ? startX : startX + i * (cardW + gap);
    const cardY = portrait ? cardY0 + i * (cardH + gap) : cardY0;
    
    // Card border & background
    const isSelected = acc.activeSlot === i;
    ctx.fillStyle = isSelected ? 'rgba(30, 24, 16, 0.95)' : 'rgba(20, 15, 10, 0.88)';
    ctx.fillRect(cx, cardY, cardW, cardH);

    ctx.strokeStyle = isSelected ? '#ffd700' : '#8a6d3b';
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    ctx.strokeRect(cx, cardY, cardW, cardH);

    // Slot Header
    ctx.fillStyle = isSelected ? '#ffd700' : '#c8a25a';
    ctx.font = 'bold 15px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`SLOT ${i + 1}`, cx + 16, cardY + 28);

    if (slot) {
      // Populated Character Card
      const raceData = RACES[slot.race] || RACES.Human;
      const genderIcon = slot.gender === 'female' ? '♀' : '♂';

      // Race Icon & Name
      ctx.font = 'bold 20px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = raceData.color || '#e8dcc0';
      ctx.fillText(`${raceData.icon} ${slot.name}`, cx + 16, cardY + 62);

      ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = '#a09070';
      ctx.fillText(`${slot.race} · ${slot.gender} ${genderIcon}`, cx + 16, cardY + 84);

      // Divider line
      ctx.strokeStyle = 'rgba(200, 162, 90, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + 16, cardY + 98);
      ctx.lineTo(cx + cardW - 16, cardY + 98);
      ctx.stroke();

      // Stats Breakdown
      let sy = cardY + 124;
      const stats = slot.stats || { str: 10, dex: 10, int: 10, vit: 10 };
      ctx.fillStyle = '#d0c0a0';
      ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText('ATTRIBUTES', cx + 16, sy);
      sy += 20;

      ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = '#e8dcc0';
      ctx.fillText(`⚔ Strength (STR):    ${stats.str}`, cx + 20, sy); sy += 20;
      ctx.fillText(`🏹 Dexterity (DEX):   ${stats.dex}`, cx + 20, sy); sy += 20;
      ctx.fillText(`🔮 Intelligence (INT): ${stats.int}`, cx + 20, sy); sy += 20;
      ctx.fillText(`❤️ Vitality (VIT):     ${stats.vit}`, cx + 20, sy); sy += 24;

      // Derived Passive Box
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(cx + 16, sy, cardW - 32, 54);
      ctx.strokeStyle = 'rgba(200,162,90,0.2)';
      ctx.strokeRect(cx + 16, sy, cardW - 32, 54);

      ctx.fillStyle = '#c8a25a';
      ctx.font = 'bold 11px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText('RACIAL TRAIT', cx + 24, sy + 18);

      ctx.fillStyle = '#a0d0a0';
      ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(raceData.passive, cx + 24, sy + 36);

      // Buttons: Play & Delete
      const btnY = cardY + cardH - 52;
      const playBtnW = cardW - 80;
      const playBtnX = cx + 16;
      
      // PLAY Button
      ctx.fillStyle = '#2a5a2a';
      ctx.fillRect(playBtnX, btnY, playBtnW, 36);
      ctx.strokeStyle = '#60c060';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(playBtnX, btnY, playBtnW, 36);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`▶ PLAY AS ${slot.name.split(' ')[0].toUpperCase()}`, playBtnX + playBtnW / 2, btnY + 22);

      charSelectHits.push({
        x: playBtnX, y: btnY, w: playBtnW, h: 36,
        fn: () => onSelectSlot(i)
      });

      // DELETE Button
      const delBtnX = cx + cardW - 54;
      ctx.fillStyle = '#5a2a2a';
      ctx.fillRect(delBtnX, btnY, 38, 36);
      ctx.strokeStyle = '#c06060';
      ctx.strokeRect(delBtnX, btnY, 38, 36);

      ctx.fillStyle = '#ff8888';
      ctx.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText('🗑️', delBtnX + 19, btnY + 23);

      charSelectHits.push({
        x: delBtnX, y: btnY, w: 38, h: 36,
        fn: () => {
          if (confirm(`Are you sure you want to delete character "${slot.name}" in Slot ${i + 1}?`)) {
            AccountManager.deleteSlot(i);
          }
        }
      });

    } else {
      // Empty Slot Card
      ctx.textAlign = 'center';
      ctx.fillStyle = '#605040';
      ctx.font = '48px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText('🛡️', cx + cardW / 2, cardY + cardH / 2 - 40);

      ctx.fillStyle = '#807060';
      ctx.font = 'bold 16px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText('EMPTY SLOT', cx + cardW / 2, cardY + cardH / 2 + 10);

      const createBtnW = cardW - 48;
      const createBtnX = cx + 24;
      const createBtnY = cardY + cardH - 64;

      ctx.fillStyle = '#3a2e1e';
      ctx.fillRect(createBtnX, createBtnY, createBtnW, 40);
      ctx.strokeStyle = '#c8a25a';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(createBtnX, createBtnY, createBtnW, 40);

      ctx.fillStyle = '#ffd700';
      ctx.font = 'bold 13px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText('➕ CREATE NEW CHARACTER', cx + cardW / 2, createBtnY + 24);

      charSelectHits.push({
        x: createBtnX, y: createBtnY, w: createBtnW, h: 40,
        fn: () => onCreateSlot(i)
      });
    }
  }

  ctx.textAlign = 'left';
  ctx.restore();
  // Hits were recorded in design space — map them into screen space so the
  // click handler (which sees raw clientX/clientY) still lines up.
  for (const hit of charSelectHits) {
    hit.x = offX + hit.x * S; hit.y = offY + hit.y * S;
    hit.w *= S; hit.h *= S;
  }
}

export function handleCharSelectClick(e) {
  for (const h of charSelectHits) {
    if (e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h) {
      h.fn();
      return true;
    }
  }
  return false;
}

// ── Render Character Creator Screen ───────────────────────────────────────
export function renderCharCreator(ctx, canvas, onConfirm, onCancel) {
  charCreatorHits = [];
  const w = (canvas && canvas.width) ? canvas.width : (window.innerWidth || 800);
  const h = (canvas && canvas.height) ? canvas.height : (window.innerHeight || 600);

  // Dark overlay background
  ctx.fillStyle = 'rgba(12, 9, 6, 0.96)';
  ctx.fillRect(0, 0, w, h);

  const panelW = Math.min(840, Math.floor(w * 0.92));
  const panelH = Math.min(620, Math.floor(h * 0.90));
  const px = (w - panelW) / 2;
  const py = (h - panelH) / 2;

  // Window frame
  ctx.fillStyle = '#16110a';
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#c8a25a';
  ctx.lineWidth = 2;
  ctx.strokeRect(px, py, panelW, panelH);

  // Title Bar
  ctx.fillStyle = '#c8a25a';
  ctx.font = 'bold 20px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`CHARACTER CREATION — SLOT ${creatorState.slotIdx + 1}`, px + panelW / 2, py + 32);

  ctx.strokeStyle = 'rgba(200, 162, 90, 0.3)';
  ctx.beginPath();
  ctx.moveTo(px + 20, py + 46);
  ctx.lineTo(px + panelW - 20, py + 46);
  ctx.stroke();

  const colW = (panelW - 60) / 2;
  const col1X = px + 20;
  const col2X = px + 40 + colW;
  let y1 = py + 62;

  ctx.textAlign = 'left';

  // ── 1. Name Entry ──
  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 13px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText('1. CHARACTER NAME', col1X, y1);
  y1 += 12;

  // Render DOM Name input position overlay
  const inputEl = ensureNameInput();
  const inputX = col1X;
  const inputY = y1 + 6;
  const inputW = colW - 130;
  const inputH = 28;

  inputEl.style.left = `${inputX}px`;
  inputEl.style.top = `${inputY}px`;
  inputEl.style.width = `${inputW}px`;
  inputEl.style.height = `${inputH - 8}px`;
  inputEl.style.display = 'block';
  inputEl.value = creatorState.name;

  // Random Name Button
  const randBtnX = col1X + colW - 120;
  const randBtnY = inputY;
  ctx.fillStyle = '#2e2417';
  ctx.fillRect(randBtnX, randBtnY, 120, inputH);
  ctx.strokeStyle = '#c8a25a';
  ctx.lineWidth = 1;
  ctx.strokeRect(randBtnX, randBtnY, 120, inputH);

  ctx.fillStyle = '#e8dcc0';
  ctx.font = 'bold 11px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('🎲 Random Name', randBtnX + 60, randBtnY + 18);
  ctx.textAlign = 'left';

  charCreatorHits.push({
    x: randBtnX, y: randBtnY, w: 120, h: inputH,
    fn: () => {
      creatorState.name = generateRandomName(creatorState.gender);
    }
  });

  y1 += inputH + 20;

  // ── 2. Gender Selection ──
  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 13px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText('2. GENDER', col1X, y1);
  y1 += 14;

  const genders = [
    { id: 'male', label: '♂ Male' },
    { id: 'female', label: '♀ Female' }
  ];
  const gBtnW = (colW - 10) / 2;

  genders.forEach((g, gi) => {
    const gx = col1X + gi * (gBtnW + 10);
    const selected = creatorState.gender === g.id;

    ctx.fillStyle = selected ? '#4a3818' : '#221a12';
    ctx.fillRect(gx, y1, gBtnW, 30);
    ctx.strokeStyle = selected ? '#ffd700' : '#705830';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(gx, y1, gBtnW, 30);

    ctx.fillStyle = selected ? '#ffffff' : '#c8a25a';
    ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(g.label, gx + gBtnW / 2, y1 + 19);
    ctx.textAlign = 'left';

    charCreatorHits.push({
      x: gx, y: y1, w: gBtnW, h: 30,
      fn: () => { creatorState.gender = g.id; }
    });
  });

  y1 += 42;

  // ── 3. Race Selection ──
  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 13px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText('3. RACE', col1X, y1);
  y1 += 14;

  const raceKeys = Object.keys(RACES);
  raceKeys.forEach((rk) => {
    const race = RACES[rk];
    const selected = creatorState.race === rk;
    const rH = 34;

    ctx.fillStyle = selected ? 'rgba(74, 56, 24, 0.9)' : 'rgba(26, 20, 14, 0.7)';
    ctx.fillRect(col1X, y1, colW, rH);
    ctx.strokeStyle = selected ? '#ffd700' : 'rgba(160, 130, 80, 0.4)';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(col1X, y1, colW, rH);

    ctx.font = '14px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = race.color;
    ctx.fillText(`${race.icon} ${race.name}`, col1X + 10, y1 + 22);

    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = selected ? '#ffffff' : '#a09070';
    ctx.textAlign = 'right';
    ctx.fillText(race.passive.split(':')[0], col1X + colW - 10, y1 + 22);
    ctx.textAlign = 'left';

    charCreatorHits.push({
      x: col1X, y: y1, w: colW, h: rH,
      fn: () => { creatorState.race = rk; }
    });

    y1 += rH + 6;
  });

  // ── Right Column: Attributes & Passives ──
  let y2 = py + 62;
  const raceData = RACES[creatorState.race] || RACES.Human;

  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 13px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText('4. ATTRIBUTES & POINTS', col2X, y2);

  ctx.textAlign = 'right';
  ctx.fillStyle = creatorState.pointsLeft > 0 ? '#60ff60' : '#a0a0a0';
  ctx.fillText(`Points Left: ${creatorState.pointsLeft}`, col2X + colW, y2);
  ctx.textAlign = 'left';
  y2 += 20;

  const statDefs = [
    { key: 'str', label: '⚔ Strength (STR)', desc: 'Melee damage & carrying capacity' },
    { key: 'dex', label: '🏹 Dexterity (DEX)', desc: 'Movement speed & archery damage' },
    { key: 'int', label: '🔮 Intelligence (INT)', desc: 'Cooldown reduction & magic power' },
    { key: 'vit', label: '❤️ Vitality (VIT)', desc: 'Max HP (+10/pt) & health regen' },
  ];

  statDefs.forEach((s) => {
    const val = creatorState.stats[s.key];
    const rBonus = raceData.bonus[s.key] || 0;
    const totalVal = val + rBonus;

    ctx.fillStyle = '#e8dcc0';
    ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(s.label, col2X, y2 + 14);

    // Minus Button
    const minusX = col2X + colW - 90;
    ctx.fillStyle = val > BASE_STAT_MIN ? '#4a2818' : '#201510';
    ctx.fillRect(minusX, y2, 22, 22);
    ctx.strokeStyle = '#c8a25a';
    ctx.strokeRect(minusX, y2, 22, 22);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText('-', minusX + 11, y2 + 15);

    charCreatorHits.push({
      x: minusX, y: y2, w: 22, h: 22,
      fn: () => {
        if (val > BASE_STAT_MIN) {
          creatorState.stats[s.key]--;
          creatorState.pointsLeft++;
        }
      }
    });

    // Stat Value Display
    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 13px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(`${totalVal}`, col2X + colW - 52, y2 + 16);
    if (rBonus > 0) {
      ctx.fillStyle = '#60ff60';
      ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(`(+${rBonus})`, col2X + colW - 32, y2 + 16);
    }

    // Plus Button
    const plusX = col2X + colW - 22;
    ctx.fillStyle = creatorState.pointsLeft > 0 && val < BASE_STAT_MAX ? '#184a18' : '#102010';
    ctx.fillRect(plusX, y2, 22, 22);
    ctx.strokeStyle = '#c8a25a';
    ctx.strokeRect(plusX, y2, 22, 22);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('+', plusX + 11, y2 + 15);
    ctx.textAlign = 'left';

    charCreatorHits.push({
      x: plusX, y: y2, w: 22, h: 22,
      fn: () => {
        if (creatorState.pointsLeft > 0 && val < BASE_STAT_MAX) {
          creatorState.stats[s.key]++;
          creatorState.pointsLeft--;
        }
      }
    });

    y2 += 28;
  });

  y2 += 10;

  // ── Calculated Derived Stats Card ──
  ctx.fillStyle = 'rgba(20, 15, 10, 0.85)';
  ctx.fillRect(col2X, y2, colW, 140);
  ctx.strokeStyle = 'rgba(200, 162, 90, 0.4)';
  ctx.strokeRect(col2X, y2, colW, 140);

  ctx.fillStyle = '#c8a25a';
  ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText('CHARACTER OVERVIEW & PASSIVES', col2X + 12, y2 + 20);

  const totalVit = creatorState.stats.vit + (raceData.bonus.vit || 0);
  const totalDex = creatorState.stats.dex + (raceData.bonus.dex || 0);
  const totalStr = creatorState.stats.str + (raceData.bonus.str || 0);
  const calcHp = 100 + (totalVit - 10) * 10;
  const calcSpeed = 190 + (totalDex - 10) * 4 + (creatorState.race === 'Centaur' ? 25 : 0);
  const meleeBonus = Math.round((totalStr - 10) * 3);

  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = '#e8dcc0';
  ctx.fillText(`• Max Health (HP): ${calcHp}`, col2X + 12, y2 + 42);
  ctx.fillText(`• Movement Speed: ${calcSpeed} px/s`, col2X + 12, y2 + 58);
  ctx.fillText(`• Melee Damage Bonus: +${meleeBonus}%`, col2X + 12, y2 + 74);

  ctx.fillStyle = '#a0d0a0';
  ctx.fillText(`• Trait: ${raceData.passive}`, col2X + 12, y2 + 96);
  if (creatorState.race === 'Vampire') {
    ctx.fillStyle = '#ff8888';
    ctx.fillText('• 👁️ Sees in dark caves & nighttime automatically!', col2X + 12, y2 + 114);
  }

  // ── Footer Action Buttons ──
  const btnY = py + panelH - 48;
  const cancelBtnX = px + 20;
  const createBtnX = px + panelW - 180;

  // Cancel Button
  ctx.fillStyle = '#4a1818';
  ctx.fillRect(cancelBtnX, btnY, 140, 36);
  ctx.strokeStyle = '#c06060';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cancelBtnX, btnY, 140, 36);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 13px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('CANCEL', cancelBtnX + 70, btnY + 22);

  charCreatorHits.push({
    x: cancelBtnX, y: btnY, w: 140, h: 36,
    fn: () => {
      hideNameInput();
      onCancel();
    }
  });

  // Create Button
  ctx.fillStyle = '#185a18';
  ctx.fillRect(createBtnX, btnY, 160, 36);
  ctx.strokeStyle = '#60c060';
  ctx.strokeRect(createBtnX, btnY, 160, 36);

  ctx.fillStyle = '#ffffff';
  ctx.fillText('✔ CREATE HERO', createBtnX + 80, btnY + 22);

  charCreatorHits.push({
    x: createBtnX, y: btnY, w: 160, h: 36,
    fn: () => {
      const charName = (creatorState.name || 'Traveler').trim();
      if (!charName) {
        alert('Please enter a character name.');
        return;
      }
      hideNameInput();
      onConfirm({
        name: charName,
        gender: creatorState.gender,
        race: creatorState.race,
        stats: { ...creatorState.stats },
        slotIdx: creatorState.slotIdx,
      });
    }
  });

  ctx.textAlign = 'left';
}

export function handleCharCreatorClick(e) {
  for (const h of charCreatorHits) {
    if (e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h) {
      h.fn();
      return true;
    }
  }
  return false;
}
