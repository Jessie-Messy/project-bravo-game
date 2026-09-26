# portal.py — the rune-gate that every map and dungeon transition walks through.
#
#   blender --background --factory-startup --python tools/blender/portal.py -- [--preview out.png]
#
# Writes models_src/portal_gate.glb (then `npm run assets` bakes it into models/).
#
# ONE MESH, TWO COLOURS. The gate ships in neutral stone; red (PvP / dungeon) and
# blue (city / safe lands) are applied at runtime by material NAME:
#   PortalStone    — masonry, vertex-coloured, keeps its own colour
#   PortalRune     — carved inlays, re-tinted and made emissive per kind
#   PortalSurface  — the membrane filling the opening; replaced by the vortex shader.
#                    Its UVs are 0..1 across the opening's bounding box, so the
#                    shader can find the centre without knowing the arch's shape.
#   PortalShard    — floating crystals (one mesh), re-tinted per kind, bobbed at runtime
# Shipping two GLBs that differ only in a colour would double the download and
# give the two kinds a way to drift apart.
#
# UNITS: 1 Blender unit = 1 game TILE (48 world units). A character is 126 units
# = 2.6 tiles tall, so the opening is 1.5 tiles wide and ~3.6 tall: a person fits
# with headroom, and it still reads as a doorway rather than a monument.
#
# AXES: the opening spans Blender X; you walk through it along Blender Y. glTF
# export turns Y into -Z, so in three.js the gate's walk axis is Z and the
# membrane lies in the XY plane.
import bpy, bmesh, math, random, sys
from mathutils import Vector

random.seed(20260926)
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PREVIEW = argv[argv.index('--preview') + 1] if '--preview' in argv else None
OUT = 'models_src/portal_gate.glb'

A    = 0.75     # half-width of the opening
HS   = 2.30     # springline: where the straight jambs stop and the arch begins
R    = 2 * A    # equilateral pointed arch — each arc is centred on the opposite springer
APEX = HS + math.sqrt(R * R - A * A)
DEPTH = 0.56    # pillar / arch thickness along the walk axis
PW   = 0.50     # pillar width
T    = 0.40     # arch ring thickness

bpy.ops.wm.read_factory_settings(use_empty=True)

# ── materials ────────────────────────────────────────────────────────────────
def mat(name, rgb, emit=0.0, rough=0.85, metal=0.0):
    m = bpy.data.materials.new(name)
    pass  # node tree exists by default in 5.x
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
        bsdf.inputs['Emission Strength'].default_value = emit
    return m

def vcol_mat(name):
    """Stone: base colour comes from the vertex colours, so per-block variation
    survives export without a texture."""
    m = bpy.data.materials.new(name)
    pass  # node tree exists by default in 5.x
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    nt.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.88
    return m

M_STONE = vcol_mat('PortalStone')
M_RUNE  = mat('PortalRune',    (0.85, 0.85, 0.9), emit=2.0, rough=0.4)
M_SURF  = mat('PortalSurface', (0.5, 0.5, 0.9),   emit=1.0, rough=0.2)
M_SHARD = mat('PortalShard',   (0.8, 0.8, 0.95),  emit=1.5, rough=0.15, metal=0.1)

# ── mesh helpers ─────────────────────────────────────────────────────────────
STONE_BASE = (0.30, 0.29, 0.31)
def stone_tint(z):
    """A per-block colour: basalt grey with a cool/warm jitter, darker toward the
    ground (grime and ambient occlusion the runtime won't compute for us)."""
    j = random.uniform(-0.05, 0.05)
    warm = random.uniform(-0.02, 0.025)
    ao = 0.72 + 0.28 * min(1.0, max(0.0, z / 1.2))
    return tuple(max(0, min(1, (c + j + warm * (1 if i == 0 else -0.5)) * ao)) for i, c in enumerate(STONE_BASE))

class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.color.new('Col')
    def add_faces(self, verts, faces, rgb, bevel=0.0):
        # Faces that existed BEFORE this piece. Bevel deletes and replaces the
        # piece's own verts/faces, so "whatever is new afterwards" is the only
        # reliable way to find what to colour.
        before = set(self.bm.faces)
        vs = [self.bm.verts.new(v) for v in verts]
        new = []
        for f in faces:
            try: new.append(self.bm.faces.new([vs[i] for i in f]))
            except ValueError: pass
        if bevel:
            edges = list({e for f in new for e in f.edges})
            bmesh.ops.bevel(self.bm, geom=edges, offset=bevel, segments=1, affect='EDGES', clamp_overlap=True)
        for f in self.bm.faces:
            if f in before: continue
            for l in f.loops: l[self.col] = (*rgb, 1.0)
    def box(self, cx, cy, cz, sx, sy, sz, rgb, bevel=0.018, taper=0.0):
        hx, hy, hz = sx / 2, sy / 2, sz / 2
        tx, ty = hx * (1 - taper), hy * (1 - taper)
        v = [(cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz), (cx + hx, cy + hy, cz - hz), (cx - hx, cy + hy, cz - hz),
             (cx - tx, cy - ty, cz + hz), (cx + tx, cy - ty, cz + hz), (cx + tx, cy + ty, cz + hz), (cx - tx, cy + ty, cz + hz)]
        f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        self.add_faces(v, f, rgb, bevel)
    def cyl(self, cx, cy, z0, z1, r, n, rgb, bevel=0.015):
        v = []
        for k in range(n):
            a = 2 * math.pi * k / n
            v.append((cx + r * math.cos(a), cy + r * math.sin(a), z0))
        for k in range(n):
            a = 2 * math.pi * k / n
            v.append((cx + r * math.cos(a), cy + r * math.sin(a), z1))
        f = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
        for k in range(n):
            k2 = (k + 1) % n
            f.append((k, k2, n + k2, n + k))
        self.add_faces(v, f, rgb, bevel)
    def finish(self, name, material):
        me = bpy.data.meshes.new(name)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        self.bm.to_mesh(me); self.bm.free()
        # ⚠ Make 'Col' the ACTIVE colour attribute. Without this the exporter
        # writes an all-white default as COLOR_0 and the real colours as COLOR_1,
        # and three.js only reads COLOR_0 — the stone came out snow white.
        ca = me.color_attributes
        ca.active_color = ca['Col']
        ca.render_color_index = list(ca).index(ca['Col'])
        ob = bpy.data.objects.new(name, me)
        bpy.context.collection.objects.link(ob)
        me.materials.append(material)
        for p in me.polygons: p.use_smooth = False
        return ob

# ── stone ────────────────────────────────────────────────────────────────────
S = Builder()

# Dais: two low stepped discs. Kept to 0.07 tiles (~3 world units) because the
# player stands at terrain height — anything taller swallows their feet.
S.cyl(0, 0, -0.04, 0.035, 1.95, 20, tuple(c * 0.85 for c in STONE_BASE), bevel=0.02)
S.cyl(0, 0, 0.035, 0.07, 1.45, 20, tuple(c * 0.95 for c in STONE_BASE), bevel=0.012)

# Pillars: plinth, three drums with mortar gaps, capital. Each drum gets its own
# tint so the pillar reads as stacked masonry rather than an extruded box.
for side in (-1, 1):
    px = side * (A + PW / 2)
    S.box(px, 0, 0.07 + 0.16, PW + 0.16, DEPTH + 0.16, 0.32, stone_tint(0.1), bevel=0.03)
    z = 0.39
    drums = [0.62, 0.55, 0.58]
    for i, h in enumerate(drums):
        S.box(px, 0, z + h / 2, PW, DEPTH, h - 0.025, stone_tint(z), bevel=0.02, taper=0.03 * i / 2)
        z += h
    S.box(px, 0, z + 0.10, PW + 0.12, DEPTH + 0.12, 0.2, stone_tint(z), bevel=0.025)
    # Top the capital exactly at the springline so the first voussoir sits on it.
    assert abs((z + 0.2) - HS) < 0.2, (z, HS)

# Arch ring: two arcs of voussoirs meeting at a keystone. Left arc is centred on
# the RIGHT springer (+A, HS) and runs from 180° (left springer) to 120° (apex).
def arc_block(cx, a0, a1, rgb, steps=4):
    inner, outer = [], []
    for k in range(steps + 1):
        a = a0 + (a1 - a0) * k / steps
        inner.append((cx + R * math.cos(a), HS + R * math.sin(a)))
        outer.append((cx + (R + T) * math.cos(a), HS + (R + T) * math.sin(a)))
    ring = inner + outer[::-1]
    n = len(ring)
    verts = [(x, -DEPTH / 2, z) for x, z in ring] + [(x, DEPTH / 2, z) for x, z in ring]
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    for k in range(n):
        k2 = (k + 1) % n
        faces.append((k, k2, n + k2, n + k))
    S.add_faces(verts, faces, rgb, bevel=0.018)

N_VOUSS = 5
GAP = math.radians(0.7)
for side in (-1, 1):
    cx = -side * A                    # left arc (side -1) is centred on the right springer
    a_start = math.radians(180 if side < 0 else 0)
    a_end = math.radians(120 if side < 0 else 60)
    for i in range(N_VOUSS):
        a0 = a_start + (a_end - a_start) * i / N_VOUSS
        a1 = a_start + (a_end - a_start) * (i + 1) / N_VOUSS
        # stop short of the apex so the keystone can own it
        if i == N_VOUSS - 1: a1 = a_start + (a_end - a_start) * 0.93
        arc_block(cx, a0 + GAP * (1 if side < 0 else -1) * 0, a1 - GAP * (1 if side < 0 else -1), stone_tint(HS + 0.5))

# Keystone: proud of the ring on both faces, so the apex catches light.
S.box(0, 0, APEX + T * 0.45, 0.34, DEPTH + 0.1, T * 1.25, tuple(c * 1.08 for c in STONE_BASE), bevel=0.03, taper=-0.12)

# Rubble at the foot of the dais — breaks the perfect circle.
for k in range(7):
    a = random.uniform(0, 2 * math.pi)
    if abs(math.sin(a)) > 0.75: continue      # keep the walk axis clear
    r = random.uniform(1.75, 2.15)
    s = random.uniform(0.10, 0.2)
    S.box(r * math.cos(a), r * math.sin(a), s * 0.35, s * 1.3, s, s * 0.8, stone_tint(0), bevel=0.03, taper=0.25)

stone = S.finish('Stone', M_STONE)

# ── runes ────────────────────────────────────────────────────────────────────
# Small proud glyph strokes on both faces of each pillar, on the arch ring, and
# a ring of marks on the dais. Separate mesh so the runtime can light them.
Rn = Builder()
W = (0.9, 0.9, 0.9)
def glyph(x, y, z, face, scale=1.0):
    """A pseudo-rune: a vertical stave plus 1-3 random branches. `face` is -1
    for the front (−Y) face, +1 for the back."""
    t = 0.022 * scale
    y0 = y + face * 0.012
    h = 0.24 * scale
    Rn.box(x, y0, z, t * 1.4, t, h, W, bevel=0)
    for _ in range(random.randint(1, 3)):
        zz = z + random.uniform(-h / 2.5, h / 2.5)
        dx = random.choice((-1, 1)) * random.uniform(0.04, 0.07) * scale
        Rn.box(x + dx / 2, y0, zz + dx * 0.35, abs(dx) + t, t, t * 1.3, W, bevel=0)

for side in (-1, 1):
    px = side * (A + PW / 2)
    for face in (-1, 1):
        y = face * DEPTH / 2
        z = 0.55
        while z < HS - 0.35:
            glyph(px, y, z, face)
            z += 0.36
# arch face runes, following the ring's centre line
for side in (-1, 1):
    cx = -side * A
    for i in range(5):
        a = math.radians((180 - 12 * (i + 0.5)) if side < 0 else (12 * (i + 0.5)))
        x = cx + (R + T / 2) * math.cos(a); z = HS + (R + T / 2) * math.sin(a)
        for face in (-1, 1):
            glyph(x, face * DEPTH / 2, z, face, scale=0.7)
# dais ring: flat marks lying on the top step
for k in range(16):
    a = 2 * math.pi * k / 16
    if abs(math.sin(a)) > 0.97: continue          # none directly on the walk line
    x, y = 1.22 * math.cos(a), 1.22 * math.sin(a)
    Rn.box(x, y, 0.075, 0.05 if k % 2 else 0.12, 0.05, 0.012, W, bevel=0)
runes = Rn.finish('Runes', M_RUNE)

# ── membrane ─────────────────────────────────────────────────────────────────
# Fills the opening exactly: straight jambs, then the two arcs to the apex.
# Convex, so a fan from the centroid triangulates it cleanly.
outline = [(-A, 0.08)]
for k in range(0, 13):
    a = math.radians(180 - 60 * k / 12)
    outline.append((A + R * math.cos(a), HS + R * math.sin(a)))
for k in range(1, 13):
    a = math.radians(60 - 60 * k / 12)
    outline.append((-A + R * math.cos(a), HS + R * math.sin(a)))
outline.append((A, 0.08))
me = bpy.data.meshes.new('Surface')
H = APEX
cz = H * 0.45
verts = [(0, 0, cz)] + [(x, 0, z) for x, z in outline]
faces = [(0, i, i + 1) for i in range(1, len(outline))] + [(0, len(outline), 1)]
me.from_pydata(verts, [], faces)
uv = me.uv_layers.new(name='UVMap')
for poly in me.polygons:
    for li in poly.loop_indices:
        v = me.vertices[me.loops[li].vertex_index].co
        uv.data[li].uv = ((v.x + A) / (2 * A), (v.z - 0.08) / (H - 0.08))
surf = bpy.data.objects.new('Surface', me)
bpy.context.collection.objects.link(surf)
me.materials.append(M_SURF)

# ── floating shards ──────────────────────────────────────────────────────────
# Elongated octahedra hovering around the arch, as ONE mesh. The bake's joinPrims
# merges same-material siblings anyway, so separate objects would only trip the
# lost-mesh check; the runtime bobs and turns the group as a whole.
Sh = Builder()
def shard(x, y, z, s, rz):
    c, sn = math.cos(rz), math.sin(rz)
    pts = [(0, 0, 1.6 * s), (0, 0, -1.6 * s), (s, 0, 0), (-s, 0, 0), (0, s, 0), (0, -s, 0)]
    pts = [(x + px * c - py * sn, y + px * sn + py * c, z + pz) for px, py, pz in pts]
    f = [(0, 2, 4), (0, 4, 3), (0, 3, 5), (0, 5, 2), (1, 4, 2), (1, 3, 4), (1, 5, 3), (1, 2, 5)]
    Sh.add_faces(pts, f, (1, 1, 1))
shard(0.0, 0.0, APEX + 0.85, 0.09, 0.4)
shard(-(A + PW) - 0.35, 0.15, HS + 0.25, 0.07, 1.1)
shard((A + PW) + 0.35, -0.15, HS + 0.45, 0.075, 2.3)
Sh.finish('Shards', M_SHARD)

# ── export ───────────────────────────────────────────────────────────────────
tri = sum(len(p.vertices) - 2 for o in bpy.data.objects if o.type == 'MESH' for p in o.data.polygons)
print('[portal] apex %.2f tiles, ~%d tris' % (APEX, tri))
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True,
                          export_apply=True, export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                          export_normals=True, export_materials='EXPORT')
print('[portal] wrote ' + OUT)

# ── optional preview render (for review; not shipped) ─────────────────────────
if PREVIEW:
    # Preview-only glow colour, so the render shows what a red gate will read as.
    for m, c in ((M_RUNE, (1.0, 0.18, 0.1)), (M_SURF, (1.0, 0.2, 0.12)), (M_SHARD, (1.0, 0.35, 0.2))):
        b = m.node_tree.nodes['Principled BSDF']
        b.inputs['Emission Color'].default_value = (*c, 1)
        b.inputs['Base Color'].default_value = (*c, 1)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 24
    sc.render.resolution_x, sc.render.resolution_y = 720, 720
    sc.render.filepath = PREVIEW
    world = bpy.data.worlds.new('W'); sc.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.35, 0.45, 0.6, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))
    bpy.context.collection.objects.link(sun)
    ground = bpy.data.meshes.new('G')
    ground.from_pydata([(-6, -6, -0.041), (6, -6, -0.041), (6, 6, -0.041), (-6, 6, -0.041)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new('G', ground); bpy.context.collection.objects.link(g)
    ground.materials.append(mat('Ground', (0.18, 0.3, 0.12)))
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    bpy.context.collection.objects.link(cam); sc.camera = cam
    cam.location = (3.6, -6.2, 2.6)
    d = Vector((0, 0, 1.9)) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 40
    bpy.ops.render.render(write_still=True)
    print('[portal] preview ' + PREVIEW)
