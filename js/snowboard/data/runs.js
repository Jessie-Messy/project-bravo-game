// runs.js — the mountain catalogue.
//
// Every run here is modelled on a real, named piste. The vertical drops, summit
// elevations and lengths are the mountains' published figures; what the game
// changes is TIME, because riding 11 km of Peak to Creek at real scale is a
// twelve-minute descent nobody finishes on a phone. `courseLength` is the
// compressed playable distance — the pitch profile keeps the character of the
// real run (where it steepens, where it flattens out, where the trees close in)
// while fitting a 60–150 second descent.
//
// Schema notes:
//   pitch  — [normalisedDistance, degrees] control points, monotonic in d.
//            The course builder splines through them, so two points far apart
//            give a long even pitch and two close together give a headwall.
//   width  — [normalisedDistance, metres] half-corridor width. Outside it the
//            terrain banks up hard, which fences the player in without an
//            invisible wall.
//   zones  — features laid over the base profile. `at`/`len` are normalised.
//   snow   — drives friction, spray colour and how deep the board sits.
//   stars  — score thresholds for 1, 2 and 3 stars.

export const RUNS = [
  {
    id: 'zermatt-matterhorn',
    mountain: 'Zermatt',
    region: 'Valais, Switzerland',
    run: 'Matterhorn Glacier Cruise',
    grade: 'green', gradeLabel: 'Beginner',
    vertical: 900, realLength: 8000, courseLength: 1500, summit: 3883,
    blurb: 'Europe’s highest lift-served snow. A wide, forgiving glacier boulevard with the Matterhorn watching over your shoulder the whole way down.',
    time: 'morning', weather: 'clear', snow: 'groomed',
    parTime: 78, stars: [4000, 9000, 15000],
    treeLine: 0.62,          // fraction of the run below which conifers appear
    trees: 0.15, rocks: 0.5, peaks: 'matterhorn',
    pitch: [[0, 9], [0.18, 14], [0.42, 11], [0.6, 17], [0.78, 12], [1, 8]],
    width: [[0, 40], [0.5, 44], [1, 38]],
    curve: 0.55,             // how much the fall line meanders, 0..2
    zones: [
      { at: 0.22, len: 0.10, type: 'rollers', amp: 0.9, wavelength: 26 },
      { at: 0.46, len: 0.08, type: 'kickers', count: 2, size: 0.7 },
      { at: 0.66, len: 0.12, type: 'gates', count: 10 },
      { at: 0.84, len: 0.09, type: 'rollers', amp: 0.6, wavelength: 20 },
    ],
  },
  {
    id: 'whistler-peak-to-creek',
    mountain: 'Whistler Blackcomb',
    region: 'British Columbia, Canada',
    run: 'Peak to Creek',
    grade: 'blue', gradeLabel: 'Intermediate',
    vertical: 1530, realLength: 11000, courseLength: 2100, summit: 2182,
    blurb: 'The full 1,530 m of it, from the alpine into old-growth coastal cedar. Starts open and windswept, finishes in a tight green tunnel at Creekside.',
    time: 'midday', weather: 'flurries', snow: 'groomed',
    parTime: 105, stars: [7000, 15000, 25000],
    treeLine: 0.30,
    trees: 0.85, rocks: 0.4, peaks: 'coastal',
    pitch: [[0, 16], [0.14, 23], [0.3, 18], [0.52, 26], [0.7, 20], [0.88, 24], [1, 15]],
    width: [[0, 38], [0.28, 30], [0.55, 24], [0.8, 20], [1, 26]],
    curve: 0.9,
    zones: [
      { at: 0.10, len: 0.08, type: 'rollers', amp: 1.2, wavelength: 30 },
      { at: 0.32, len: 0.14, type: 'gladed', density: 0.5 },
      { at: 0.50, len: 0.07, type: 'kickers', count: 3, size: 1.0 },
      { at: 0.62, len: 0.10, type: 'bank' },
      { at: 0.76, len: 0.14, type: 'gladed', density: 0.8 },
      { at: 0.92, len: 0.06, type: 'cattrack' },
    ],
  },
  {
    id: 'mammoth-unbound',
    mountain: 'Mammoth Mountain',
    region: 'California, USA',
    run: 'Unbound Main Park',
    grade: 'blue', gradeLabel: 'Freestyle',
    vertical: 900, realLength: 1600, courseLength: 1400, summit: 3369,
    blurb: 'Sierra cement groomed into cathedral-sized booters and a 22-foot superpipe. Bluebird, windless, and every feature in the park pointed straight at you.',
    time: 'midday', weather: 'clear', snow: 'groomed',
    parTime: 80, stars: [10000, 22000, 38000],
    treeLine: 0.5,
    trees: 0.25, rocks: 0.2, peaks: 'sierra',
    pitch: [[0, 14], [0.2, 17], [0.45, 15], [0.7, 18], [1, 13]],
    width: [[0, 30], [0.5, 28], [1, 30]],
    curve: 0.25,
    zones: [
      { at: 0.06, len: 0.10, type: 'rails', count: 3 },
      { at: 0.20, len: 0.16, type: 'kickers', count: 3, size: 1.25 },
      { at: 0.42, len: 0.20, type: 'halfpipe', depth: 6.7, radius: 10 },
      { at: 0.66, len: 0.12, type: 'kickers', count: 2, size: 1.6 },
      { at: 0.82, len: 0.10, type: 'rails', count: 4 },
    ],
  },
  {
    id: 'niseko-strawberry',
    mountain: 'Niseko United',
    region: 'Hokkaidō, Japan',
    run: 'Strawberry Fields',
    grade: 'black', gradeLabel: 'Advanced',
    vertical: 1000, realLength: 4000, courseLength: 1800, summit: 1308,
    blurb: 'Fifteen metres of Siberian powder a season, falling on birch glades the whole way down. You will not see your board again until the run-out.',
    time: 'dusk', weather: 'storm', snow: 'powder',
    parTime: 110, stars: [9000, 18000, 30000],
    treeLine: 0.05,
    trees: 1.0, rocks: 0.15, peaks: 'yotei',
    pitch: [[0, 18], [0.2, 24], [0.45, 21], [0.68, 27], [0.86, 22], [1, 16]],
    width: [[0, 30], [0.35, 24], [0.7, 21], [1, 28]],
    curve: 1.15,
    zones: [
      { at: 0.08, len: 0.22, type: 'gladed', density: 0.85 },
      { at: 0.34, len: 0.10, type: 'rollers', amp: 1.6, wavelength: 22 },
      { at: 0.48, len: 0.24, type: 'gladed', density: 1.0 },
      { at: 0.74, len: 0.08, type: 'cliff', drop: 3.5 },
      { at: 0.84, len: 0.14, type: 'gladed', density: 0.7 },
    ],
  },
  {
    id: 'st-anton-kandahar',
    mountain: 'St. Anton am Arlberg',
    region: 'Tyrol, Austria',
    run: 'Kandahar Descent',
    grade: 'black', gradeLabel: 'Advanced',
    vertical: 1300, realLength: 5200, courseLength: 1900, summit: 2811,
    blurb: 'The Arlberg’s race pedigree, scraped down to blue ice by nine o’clock. Pure speed — hold an edge or don’t hold anything at all.',
    time: 'morning', weather: 'clear', snow: 'hardpack',
    parTime: 92, stars: [9000, 19000, 32000],
    treeLine: 0.55,
    trees: 0.5, rocks: 0.75, peaks: 'alps',
    pitch: [[0, 20], [0.12, 30], [0.28, 24], [0.46, 33], [0.64, 26], [0.82, 31], [1, 18]],
    width: [[0, 32], [0.3, 24], [0.6, 20], [1, 26]],
    curve: 0.85,
    zones: [
      { at: 0.10, len: 0.14, type: 'gates', count: 14 },
      { at: 0.30, len: 0.10, type: 'bank' },
      { at: 0.44, len: 0.12, type: 'rollers', amp: 1.1, wavelength: 34 },
      { at: 0.60, len: 0.14, type: 'gates', count: 16 },
      { at: 0.80, len: 0.10, type: 'kickers', count: 2, size: 1.1 },
    ],
  },
  {
    id: 'verbier-tortin',
    mountain: 'Verbier',
    region: 'Valais, Switzerland',
    run: 'Tortin',
    grade: 'black', gradeLabel: 'Advanced',
    vertical: 700, realLength: 2500, courseLength: 1500, summit: 2950,
    blurb: 'Ungroomed, unpitying, and bumped into VW-sized moguls by lunchtime. The Four Valleys’ rite of passage.',
    time: 'afternoon', weather: 'overcast', snow: 'crud',
    parTime: 96, stars: [8000, 17000, 28000],
    treeLine: 0.75,
    trees: 0.3, rocks: 0.6, peaks: 'alps',
    pitch: [[0, 24], [0.16, 32], [0.38, 28], [0.58, 34], [0.78, 27], [1, 20]],
    width: [[0, 34], [0.4, 28], [1, 30]],
    curve: 0.7,
    zones: [
      { at: 0.08, len: 0.26, type: 'moguls', amp: 1.5, wavelength: 11 },
      { at: 0.38, len: 0.10, type: 'bank' },
      { at: 0.50, len: 0.30, type: 'moguls', amp: 1.9, wavelength: 10 },
      { at: 0.84, len: 0.10, type: 'rollers', amp: 1.0, wavelength: 24 },
    ],
  },
  {
    id: 'revelstoke-last-spike',
    mountain: 'Revelstoke',
    region: 'British Columbia, Canada',
    run: 'The Last Spike',
    grade: 'black', gradeLabel: 'Advanced',
    vertical: 1713, realLength: 15200, courseLength: 2400, summit: 2225,
    blurb: 'The greatest lift-served vertical in North America — 1,713 m of it, unbroken. Alpine bowl into interior cedar, and the valley fog never quite lifts.',
    time: 'morning', weather: 'snow', snow: 'powder',
    parTime: 128, stars: [11000, 22000, 36000],
    treeLine: 0.36,
    trees: 0.9, rocks: 0.45, peaks: 'monashee',
    pitch: [[0, 17], [0.12, 25], [0.3, 20], [0.48, 28], [0.66, 22], [0.84, 26], [1, 16]],
    width: [[0, 46], [0.3, 34], [0.6, 26], [1, 24]],
    curve: 1.0,
    zones: [
      { at: 0.06, len: 0.16, type: 'bowl' },
      { at: 0.26, len: 0.10, type: 'rollers', amp: 1.4, wavelength: 28 },
      { at: 0.40, len: 0.18, type: 'gladed', density: 0.6 },
      { at: 0.60, len: 0.08, type: 'cliff', drop: 4.5 },
      { at: 0.70, len: 0.20, type: 'gladed', density: 0.9 },
      { at: 0.92, len: 0.06, type: 'cattrack' },
    ],
  },
  {
    id: 'aspen-highland-bowl',
    mountain: 'Aspen Highlands',
    region: 'Colorado, USA',
    run: 'Highland Bowl',
    grade: 'double', gradeLabel: 'Expert',
    vertical: 780, realLength: 2400, courseLength: 1600, summit: 3777,
    blurb: 'A forty-five-minute bootpack up a knife ridge buys you 780 m of 45-degree bowl. Nobody has ever regretted the hike.',
    time: 'midday', weather: 'clear', snow: 'powder',
    parTime: 84, stars: [12000, 24000, 40000],
    treeLine: 0.68,
    trees: 0.4, rocks: 0.8, peaks: 'rockies',
    pitch: [[0, 36], [0.14, 42], [0.34, 38], [0.56, 41], [0.76, 32], [1, 22]],
    width: [[0, 50], [0.4, 42], [0.75, 30], [1, 26]],
    curve: 0.6,
    zones: [
      { at: 0.02, len: 0.30, type: 'bowl' },
      { at: 0.36, len: 0.10, type: 'cliff', drop: 5.0 },
      { at: 0.50, len: 0.18, type: 'bowl' },
      { at: 0.72, len: 0.16, type: 'gladed', density: 0.55 },
    ],
  },
  {
    id: 'jackson-corbets',
    mountain: 'Jackson Hole',
    region: 'Wyoming, USA',
    run: 'Corbet’s Couloir',
    grade: 'double', gradeLabel: 'Expert',
    vertical: 1260, realLength: 3000, courseLength: 1700, summit: 3185,
    blurb: 'The most famous mandatory air in America. A 3-to-6 metre drop through a rock throat onto a 50-degree apron, then you still have to ride the rest of it.',
    time: 'morning', weather: 'clear', snow: 'powder',
    parTime: 88, stars: [13000, 26000, 44000],
    treeLine: 0.62,
    trees: 0.45, rocks: 0.95, peaks: 'tetons',
    pitch: [[0, 30], [0.06, 46], [0.16, 40], [0.34, 33], [0.54, 37], [0.74, 28], [1, 20]],
    width: [[0, 16], [0.1, 13], [0.22, 26], [0.5, 34], [1, 30]],
    curve: 0.75,
    zones: [
      { at: 0.02, len: 0.06, type: 'chute' },
      { at: 0.03, len: 0.03, type: 'cliff', drop: 6.0 },
      { at: 0.12, len: 0.12, type: 'chute' },
      { at: 0.34, len: 0.14, type: 'bowl' },
      { at: 0.52, len: 0.10, type: 'cliff', drop: 4.0 },
      { at: 0.66, len: 0.18, type: 'gladed', density: 0.5 },
    ],
  },
  {
    id: 'chamonix-vallee-blanche',
    mountain: 'Chamonix Mont-Blanc',
    region: 'Haute-Savoie, France',
    run: 'Vallée Blanche',
    grade: 'double', gradeLabel: 'Expert',
    vertical: 2800, realLength: 22000, courseLength: 2600, summit: 3842,
    blurb: 'Off the Aiguille du Midi arête onto the Mer de Glace: 22 km of glacier, seracs the size of apartment blocks, and crevasses that do not forgive a missed line.',
    time: 'dawn', weather: 'clear', snow: 'powder',
    parTime: 140, stars: [14000, 28000, 46000],
    treeLine: 0.88,
    trees: 0.2, rocks: 0.7, peaks: 'montblanc',
    pitch: [[0, 26], [0.12, 34], [0.3, 22], [0.46, 30], [0.62, 19], [0.78, 27], [1, 14]],
    width: [[0, 22], [0.16, 36], [0.45, 30], [0.7, 40], [1, 34]],
    curve: 1.25,
    zones: [
      { at: 0.04, len: 0.10, type: 'chute' },
      { at: 0.18, len: 0.16, type: 'crevasse', count: 5 },
      { at: 0.38, len: 0.12, type: 'seracs' },
      { at: 0.52, len: 0.14, type: 'crevasse', count: 6 },
      { at: 0.68, len: 0.10, type: 'rollers', amp: 1.3, wavelength: 30 },
      { at: 0.80, len: 0.12, type: 'seracs' },
    ],
  },
];

export const GRADE_META = {
  green:  { color: '#4ade80', symbol: '●', name: 'Green Circle' },
  blue:   { color: '#60a5fa', symbol: '■', name: 'Blue Square' },
  black:  { color: '#e5e7eb', symbol: '◆', name: 'Black Diamond' },
  double: { color: '#f472b6', symbol: '◆◆', name: 'Double Black' },
};

// Snow types: friction and how much the board sinks. `spray` scales the
// particle burst so powder throws a plume and ice throws almost nothing.
export const SNOW_TYPES = {
  groomed:  { friction: 1.00, drag: 0.35, grip: 1.00, spray: 0.8, sink: 0.03, tint: 0xffffff },
  powder:   { friction: 1.35, drag: 1.00, grip: 0.80, spray: 2.0, sink: 0.26, tint: 0xf4f9ff },
  hardpack: { friction: 0.82, drag: 0.18, grip: 1.15, spray: 0.45, sink: 0.01, tint: 0xeaf2ff },
  crud:     { friction: 1.18, drag: 0.62, grip: 0.88, spray: 1.25, sink: 0.14, tint: 0xf2f6fb },
  ice:      { friction: 0.68, drag: 0.10, grip: 0.62, spray: 0.25, sink: 0.00, tint: 0xdfeaf7 },
};

export function runById(id) { return RUNS.find(r => r.id === id) || RUNS[0]; }
