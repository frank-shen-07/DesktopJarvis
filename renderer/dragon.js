/*
 * The dragon behind the core.
 *
 * A dragon's head facing the viewer, shown as a hologram of warm gold light: there are no
 * surfaces. A 3D model of the head is scattered with thousands of glowing points, banded
 * with broken arcs, crossed by thin rays and circled by slow rings, with out-of-focus discs
 * of light drifting through it. Fire rolls off the back of the skull. The head turns to
 * follow the pointer, blinks, and moves its jaw with DesktopJarvis's voice. When cards are being
 * drawn on the board it looks down at them with its mouth wide open (the jet of fire
 * itself is drawn by forge.js).
 *
 * Model space: x to the viewer's right, y down, z towards the viewer. One unit is roughly
 * the width of the skull; the whole head is scaled to the core's ring when drawn.
 */
(() => {
  "use strict";

  const TAU = Math.PI * 2;
  const CAMERA = 3.4;
  const SIZE = 1.18;
  // The head rests tipped slightly down, glaring out from under its brows.
  const REST_PITCH = -0.14;
  const PIVOT_Y = 0.1;
  const PIVOT_Z = -0.3;
  const HINGE_Y = 0.46;
  const HINGE_Z = 0;
  const LIGHT = normalise([-0.32, -0.74, 0.58]);

  const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => {
    const c = clamp(t);
    return c * c * (3 - 2 * c);
  };
  const radians = (degrees) => (degrees * Math.PI) / 180;
  function normalise([x, y, z]) {
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length];
  }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const mirror = (points) => points.map(([x, y, z]) => [-x, y, z]);

  /** Colours along a ramp of [position, r, g, b] stops, as a table of [r, g, b]. */
  function ramp(stops, size) {
    const table = [];
    for (let i = 0; i < size; i += 1) {
      const t = i / (size - 1);
      let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1][0]) k += 1;
      const a = stops[k];
      const b = stops[k + 1];
      const f = clamp((t - a[0]) / (b[0] - a[0] || 1));
      table.push([1, 2, 3].map((channel) => Math.round(mix(a[channel], b[channel], f))));
    }
    return table;
  }

  // Light of the hologram: dim amber, through gold, to nearly white.
  const HOLO = ramp(
    [
      [0, 150, 54, 4],
      [0.3, 236, 114, 12],
      [0.6, 255, 177, 55],
      [1, 255, 227, 172],
    ],
    64,
  );
  // A flame over its life: white-hot, gold, orange, then a dying red ember.
  const FIRE = ramp(
    [
      [0, 255, 232, 189],
      [0.12, 255, 206, 101],
      [0.35, 255, 149, 34],
      [0.6, 240, 92, 14],
      [0.85, 150, 42, 8],
      [1, 60, 14, 4],
    ],
    24,
  );
  // The hottest fire, for breath: it stays close to white.
  const WHITE = ramp(
    [
      [0, 255, 237, 206],
      [0.4, 255, 219, 143],
      [0.8, 255, 167, 59],
      [1, 200, 90, 20],
    ],
    24,
  );

  /** Smooth a few hand-placed 3D points into `count` evenly sampled ones. */
  function curve(points, count) {
    const last = points.length - 1;
    const out = [];
    for (let j = 0; j < count; j += 1) {
      const t = (j / (count - 1)) * last;
      const i = Math.min(last - 1, Math.floor(t));
      const f = t - i;
      const a = points[Math.max(i - 1, 0)];
      const b = points[i];
      const c = points[i + 1];
      const d = points[Math.min(i + 2, last)];
      out.push(
        [0, 1, 2].map(
          (axis) =>
            0.5 *
            (2 * b[axis] +
              (c[axis] - a[axis]) * f +
              (2 * a[axis] - 5 * b[axis] + 4 * c[axis] - d[axis]) * f * f +
              (3 * b[axis] - a[axis] - 3 * c[axis] + d[axis]) * f * f * f),
        ),
      );
    }
    return out;
  }

  // ---------------------------------------------------------------- Model

  const VERTS = []; // [x, y, z, movesWithJaw]
  const FACES = [];
  const LINES = []; // { ids: vertex indices, kind: "ring" | "ray" | "edge" | "rib", index }

  function vertex(point, jaw) {
    VERTS.push([point[0], point[1], point[2], jaw ? 1 : 0]);
    return VERTS.length - 1;
  }

  /** A quad (or a triangle when d is -1). `inside` is any point on the hidden side of it. */
  function face(a, b, c, d, inside, props) {
    const corners = (d < 0 ? [a, b, c] : [a, b, c, d]).map((index) => VERTS[index]);
    const centre = [0, 1, 2].map((axis) => corners.reduce((sum, corner) => sum + corner[axis], 0) / corners.length);
    const normal = faceNormal(corners);
    const outward = [0, 1, 2].reduce((sum, axis) => sum + normal[axis] * (centre[axis] - inside[axis]), 0);
    FACES.push({
      a,
      b,
      c,
      d,
      sign: outward >= 0 ? 1 : -1,
      kind: "skin",
      row: 0,
      col: 0,
      along: 0,
      double: false,
      tint: Math.random(),
      ...props,
    });
  }
  function faceNormal(corners) {
    const [p, q, r, s] = corners;
    return s
      ? cross([r[0] - p[0], r[1] - p[1], r[2] - p[2]], [s[0] - q[0], s[1] - q[1], s[2] - q[2]])
      : cross([q[0] - p[0], q[1] - p[1], q[2] - p[2]], [r[0] - p[0], r[1] - p[1], r[2] - p[2]]);
  }

  /** A skin stretched over columns of points. Returns the vertex indices as [column][row]. */
  function sheet(columns, props, jaw = false) {
    const grid = columns.map((column) => column.map((point) => vertex(point, jaw)));
    const rows = columns[0].length;
    const centres = [];
    for (let r = 0; r < rows; r += 1) {
      centres.push([0, 1, 2].map((axis) => columns.reduce((sum, column) => sum + column[r][axis], 0) / columns.length));
    }
    for (let c = 0; c < columns.length - 1; c += 1) {
      for (let r = 0; r < rows - 1; r += 1) {
        const inside = props.inside ?? [0, 1, 2].map((axis) => (centres[r][axis] + centres[r + 1][axis]) / 2);
        face(grid[c][r], grid[c + 1][r], grid[c + 1][r + 1], grid[c][r + 1], inside, {
          ...props,
          row: r,
          col: c,
          along: r / (rows - 1),
        });
      }
    }
    // Contours: an arc round each cross-section, and a few rays running the length.
    if (columns.length > 2) {
      for (let r = 1; r < rows; r += 1) LINES.push({ ids: grid.map((column) => column[r]), kind: "ring", index: r });
      for (let c = 1; c < columns.length; c += 3) LINES.push({ ids: grid[c], kind: "ray", index: c });
    } else {
      for (let r = 0; r < rows; r += 1) LINES.push({ ids: grid.map((column) => column[r]), kind: "rib", index: r });
    }
    return grid;
  }

  /** A tapering tube along a curve: horns, spikes and teeth. */
  function tube(points, from, to, sides, props, jaw = false, samples = 8) {
    const spine = points.length === samples ? points : curve(points, samples);
    let up = null;
    const rings = spine.map((point, i) => {
      const next = spine[Math.min(i + 1, spine.length - 1)];
      const previous = spine[Math.max(i - 1, 0)];
      const tangent = normalise([next[0] - previous[0], next[1] - previous[1], next[2] - previous[2]]);
      // Carry the frame along the curve so the tube does not twist.
      const guess = up ?? (Math.abs(tangent[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
      const lean = guess[0] * tangent[0] + guess[1] * tangent[1] + guess[2] * tangent[2];
      up = normalise([guess[0] - tangent[0] * lean, guess[1] - tangent[1] * lean, guess[2] - tangent[2] * lean]);
      const side = cross(tangent, up);
      const radius = mix(from, to, Math.pow(i / (spine.length - 1), 0.85));
      const ring = [];
      for (let k = 0; k < sides; k += 1) {
        const angle = (k / sides) * TAU;
        ring.push(
          vertex(
            [0, 1, 2].map((axis) => point[axis] + radius * (Math.cos(angle) * up[axis] + Math.sin(angle) * side[axis])),
            jaw,
          ),
        );
      }
      return ring;
    });
    for (let i = 0; i < rings.length - 1; i += 1) {
      const inside = [0, 1, 2].map((axis) => (spine[i][axis] + spine[i + 1][axis]) / 2);
      for (let k = 0; k < sides; k += 1) {
        const n = (k + 1) % sides;
        face(rings[i][k], rings[i][n], rings[i + 1][n], rings[i + 1][k], inside, {
          kind: "horn",
          ...props,
          row: i,
          col: k,
          along: i / (rings.length - 1),
        });
      }
    }
    for (const k of [0, Math.floor(sides / 2)])
      LINES.push({ ids: rings.map((ring) => ring[k]), kind: props.kind === "tooth" ? "tooth" : "edge", index: k });
  }
  function tubes(points, from, to, sides, props, jaw, samples) {
    tube(points, from, to, sides, props, jaw, samples);
    tube(mirror(points), from, to, sides, props, jaw, samples);
  }

  // Upper skull as cross-sections from the nose back: [z, top of skull, lip line, half width].
  const LIP = Math.sin(radians(35));
  const UPPER = [
    [1.1, 0.22, 0.42, 0.1],
    [0.9, 0.17, 0.425, 0.15],
    [0.65, 0.03, 0.435, 0.22],
    [0.4, -0.24, 0.44, 0.4],
    [0.2, -0.44, 0.45, 0.56],
    [-0.1, -0.55, 0.45, 0.64],
    [-0.4, -0.5, 0.42, 0.56],
    [-0.75, -0.32, 0.36, 0.36],
  ];
  function upper(index, angle) {
    const [z, top, lip, half] = UPPER[index];
    const tall = (lip - top) / (1 + LIP);
    return [half * Math.cos(angle), top + tall + tall * Math.sin(angle), z];
  }
  // Lower jaw as half cross-sections: [z, tooth line, half width, depth below].
  const LOWER = [
    [1.0, 0.47, 0.07, 0.06],
    [0.75, 0.47, 0.12, 0.1],
    [0.5, 0.47, 0.2, 0.14],
    [0.25, 0.47, 0.32, 0.18],
    [-0.05, 0.46, 0.46, 0.22],
    [-0.4, 0.45, 0.44, 0.3],
    [-0.75, 0.4, 0.34, 0.3],
  ];
  function lower(index, angle) {
    const [z, line, half, deep] = LOWER[index];
    return [half * Math.cos(angle), line + deep * Math.sin(angle), z];
  }

  const SKULL_ROWS = 13;
  const skullColumns = [];
  for (let degrees = -215; degrees <= 35.01; degrees += 12.5) {
    const angle = radians(degrees);
    skullColumns.push(curve([[0, 0.34, 1.2], ...UPPER.map((_, i) => upper(i, angle))], SKULL_ROWS));
  }
  const skull = sheet(skullColumns, { kind: "skin" });

  const JAW_ROWS = 10;
  const jawColumns = [];
  for (let degrees = 0; degrees <= 180.01; degrees += 15) {
    const angle = radians(degrees);
    jawColumns.push(curve([[0, 0.5, 1.08], ...LOWER.map((_, i) => lower(i, angle))], JAW_ROWS));
  }
  const jawSkin = sheet(jawColumns, { kind: "skin" }, true);
  const SKIN_VERTS = VERTS.length;

  // Roof and floor of the mouth, which glow like a furnace.
  for (let r = 0; r < SKULL_ROWS - 1; r += 1) {
    const left = skull[0];
    const right = skull[skull.length - 1];
    face(left[r], right[r], right[r + 1], left[r + 1], [0, -1, 0], {
      kind: "mouth",
      row: r,
      along: r / (SKULL_ROWS - 1),
    });
  }
  for (let r = 0; r < JAW_ROWS - 1; r += 1) {
    const right = jawSkin[0];
    const left = jawSkin[jawSkin.length - 1];
    face(left[r], right[r], right[r + 1], left[r + 1], [0, 2, 0], { kind: "mouth", row: r, along: r / (JAW_ROWS - 1) });
  }

  // Brow: heavy over the eye, sweeping back into a spike.
  tubes(
    [
      [0.08, -0.08, 0.6],
      [0.2, -0.2, 0.56],
      [0.38, -0.28, 0.45],
      [0.56, -0.35, 0.24],
      [0.72, -0.42, 0.0],
      [0.95, -0.56, -0.38],
    ],
    0.062,
    0.005,
    5,
    {},
    false,
    9,
  );
  // Cheekbone, flaring into a spike.
  tubes(
    [
      [0.16, 0.09, 0.62],
      [0.3, 0.06, 0.52],
      [0.48, 0.04, 0.33],
      [0.64, 0.02, 0.1],
      [0.84, -0.03, -0.25],
      [1.08, -0.12, -0.52],
    ],
    0.042,
    0.004,
    5,
    {},
    false,
    9,
  );
  // Horns.
  tubes(
    [
      [0.3, -0.48, 0.0],
      [0.42, -0.8, -0.1],
      [0.6, -1.08, -0.3],
      [0.8, -1.25, -0.55],
      [0.92, -1.28, -0.8],
    ],
    0.11,
    0.006,
    7,
    {},
    false,
    10,
  );
  tubes(
    [
      [0.5, -0.4, -0.05],
      [0.7, -0.6, -0.15],
      [0.95, -0.72, -0.35],
      [1.15, -0.7, -0.6],
    ],
    0.075,
    0.005,
    6,
    {},
    false,
    8,
  );
  // Frill behind the jaw: two spines with a membrane between them.
  const frillTop = [
    [0.6, 0.08, -0.05],
    [0.82, 0.13, -0.2],
    [1.0, 0.1, -0.4],
    [1.15, 0.0, -0.6],
  ];
  const frillLow = [
    [0.56, 0.3, -0.05],
    [0.76, 0.42, -0.2],
    [0.92, 0.5, -0.4],
    [1.05, 0.48, -0.6],
  ];
  for (const side of [1, -1]) {
    const top = side > 0 ? frillTop : mirror(frillTop);
    const low = side > 0 ? frillLow : mirror(frillLow);
    tube(top, 0.045, 0.004, 5, {}, false, 7);
    tube(low, 0.04, 0.004, 5, {}, false, 7);
    sheet([curve(top, 7), curve(low, 7)], { kind: "fin", double: true, inside: [0, 0.2, -3] });
  }
  // Crest of spikes down the middle of the skull, and a small one on the nose.
  for (const [z, top, tall] of [
    [0.3, -0.33, 0.2],
    [0.1, -0.5, 0.26],
    [-0.12, -0.55, 0.32],
    [-0.34, -0.51, 0.36],
    [-0.56, -0.42, 0.34],
  ]) {
    tube(
      [
        [0, top + 0.03, z],
        [0, top - tall * 0.6, z - tall * 0.35],
        [0, top - tall, z - tall * 0.9],
      ],
      0.06,
      0.004,
      5,
      {},
      false,
      5,
    );
  }
  tube(
    [
      [0, 0.22, 1.04],
      [0, 0.1, 1.06],
      [0, -0.02, 1.0],
    ],
    0.035,
    0.004,
    5,
    {},
    false,
    4,
  );
  // Chin spikes and beard, which move with the jaw.
  tubes(
    [
      [0.16, 0.6, 0.5],
      [0.2, 0.76, 0.42],
      [0.26, 0.92, 0.3],
    ],
    0.04,
    0.004,
    5,
    {},
    true,
    5,
  );
  tube(
    [
      [0, 0.54, 0.92],
      [0, 0.78, 0.86],
      [0, 1.0, 0.66],
    ],
    0.045,
    0.004,
    5,
    {},
    true,
    5,
  );

  // Teeth: [root, tip], mirrored; the lower ones move with the jaw.
  for (const [root, tip, jaw] of [
    [[0.045, 0.42, 1.1], [0.045, 0.5, 1.09], false],
    [[0.1, 0.42, 1.0], [0.108, 0.68, 0.97], false],
    [[0.14, 0.425, 0.85], [0.145, 0.55, 0.83], false],
    [[0.18, 0.43, 0.7], [0.185, 0.54, 0.68], false],
    [[0.24, 0.435, 0.56], [0.245, 0.53, 0.54], false],
    [[0.31, 0.44, 0.44], [0.315, 0.52, 0.42], false],
    [[0.4, 0.445, 0.3], [0.4, 0.51, 0.29], false],
    [[0.065, 0.47, 0.97], [0.07, 0.37, 0.95], true],
    [[0.115, 0.47, 0.78], [0.115, 0.39, 0.77], true],
    [[0.17, 0.47, 0.6], [0.17, 0.4, 0.59], true],
    [[0.25, 0.47, 0.4], [0.25, 0.41, 0.39], true],
  ]) {
    tubes([root, tip], 0.034, 0.003, 4, { kind: "tooth" }, jaw, 2);
  }

  // Eyes: centre, a vector along the lid (towards the outer corner) and one down it.
  const EYES = [1, -1].map((side) => ({
    side,
    centre: [side * 0.31, -0.115, 0.44],
    along: [side * 0.118, -0.058, -0.045],
    down: [0, 0.062, 0.014],
  }));
  const NOSTRILS = [
    [0.062, 0.255, 1.12],
    [-0.062, 0.255, 1.12],
  ];
  const WHISKERS = [1, -1].map((side) =>
    curve(
      [
        [side * 0.1, 0.36, 1.05],
        [side * 0.38, 0.42, 1.12],
        [side * 0.66, 0.3, 0.98],
        [side * 0.86, 0.4, 0.74],
        [side * 0.96, 0.64, 0.52],
        [side * 0.9, 0.86, 0.42],
      ],
      40,
    ),
  );

  // Scatter points of light over the whole model: [x, y, z, jaw, face, phase, size] each.
  const STRIDE = 7;
  const CLOUD = (() => {
    const density = { skin: 1, horn: 1.7, fin: 0.6, tooth: 3, mouth: 0 };
    const areas = FACES.map((f) => {
      const [a, b, c, d] = [f.a, f.b, f.c, f.d].map((index) => VERTS[index]);
      const half = (p, q, r) =>
        Math.hypot(...cross([q[0] - p[0], q[1] - p[1], q[2] - p[2]], [r[0] - p[0], r[1] - p[1], r[2] - p[2]])) / 2;
      return (half(a, b, c) + (d ? half(a, c, d) : 0)) * density[f.kind];
    });
    const total = areas.reduce((sum, area) => sum + area, 0);
    const out = [];
    FACES.forEach((f, index) => {
      const share = (areas[index] / total) * 13000;
      const count = Math.floor(share) + (Math.random() < share % 1 ? 1 : 0);
      const [a, b, c, d] = [f.a, f.b, f.c, f.d].map((i) => VERTS[i]);
      for (let n = 0; n < count; n += 1) {
        const u = Math.random();
        const v = Math.random();
        const far = d ?? c;
        for (let axis = 0; axis < 3; axis += 1) {
          out.push(mix(mix(a[axis], b[axis], u), mix(far[axis], c[axis], u), v));
        }
        out.push(a[3], index, Math.random(), Math.random());
      }
    });
    return new Float32Array(out);
  })();

  // Circuit traces: a vertex to start from and a few right-angled steps.
  const GLYPHS = Array.from({ length: 46 }, () => {
    const steps = [];
    let across = Math.random() < 0.5;
    for (let n = 3 + Math.floor(Math.random() * 4); n > 0; n -= 1) {
      const reach = (4 + Math.random() * 13) * (Math.random() < 0.5 ? -1 : 1);
      steps.push(across ? [reach, 0] : [0, reach]);
      across = !across;
    }
    return { vertex: Math.floor(Math.random() * SKIN_VERTS), steps, phase: Math.random() * 100 };
  });

  // ---------------------------------------------------------------- Pose

  const pose = { yaw: 0, pitch: 0, roll: 0, jaw: 0.1, lean: 1, eye: 1, heat: 0.5, breath: 0, follow: 0 };
  const pointer = { x: 0, y: 0, at: -1e9 };
  let centre = null;
  let nextBlink = 2600;
  let blinkStart = -1e9;

  addEventListener("pointermove", (event) => {
    if (!centre) return;
    pointer.x = clamp((event.clientX - centre.x) / (innerWidth * 0.4), -1, 1);
    pointer.y = clamp((event.clientY - centre.y) / (innerHeight * 0.4), -1, 1);
    pointer.at = performance.now();
  });
  addEventListener("resize", () => {
    centre = null;
  });
  document.documentElement.addEventListener("pointerleave", () => {
    pointer.at = -1e9;
  });

  function updatePose(state) {
    const { time, elapsed, phase, loudness, voiced, still, forge } = state;
    if (still) {
      // Reduced motion: no turning, swaying or flapping; the head holds one calm pose.
      Object.assign(pose, {
        yaw: 0,
        pitch: REST_PITCH,
        roll: 0,
        jaw: 0.1,
        lean: 1,
        eye: 1,
        heat: 0.5,
        breath: phase === "speaking" ? 0.4 : 0,
      });
      return;
    }
    const ease = (tau) => 1 - Math.exp(-elapsed / tau);

    const following = performance.now() - pointer.at < 3500 ? 1 : 0;
    pose.follow += (following - pose.follow) * ease(500);
    let yaw = mix(0.2 * Math.sin(time / 2600) + 0.07 * Math.sin(time / 1100), pointer.x * 0.5, pose.follow);
    let pitch = REST_PITCH + mix(0.05 * Math.sin(time / 1900), 0.05 - pointer.y * 0.3, pose.follow);
    let roll = 0.03 * Math.sin(time / 3100);
    let jaw = 0.1 + 0.03 * Math.sin(time / 1300);
    let lean = 1;
    let eye = 1;
    let breath = 0;
    let heat = 0.5;

    if (phase === "listening") {
      // Leans in with its head cocked, mouth shut, eyes wide.
      roll += 0.1;
      pitch += 0.05;
      jaw = 0.03;
      lean = 1.07;
      eye = 1.2;
      heat = 0.65 + loudness * 0.6;
    } else if (phase === "working") {
      // Looks about while it thinks, eyes narrowed, a little flame at the mouth.
      yaw += 0.2 * Math.sin(time / 700);
      roll -= 0.05;
      jaw = 0.16 + 0.05 * Math.sin(time / 300);
      eye = 0.62;
      breath = 0.22;
      heat = 1;
    } else if (phase === "speaking") {
      // The jaw follows the voice; without a signal to read, it mouths a plausible rhythm.
      const level = voiced
        ? clamp(loudness * 2.4)
        : Math.abs(Math.sin(time / 110)) * (0.55 + 0.45 * Math.sin(time / 370));
      jaw = 0.08 + level * 0.5;
      pitch += level * 0.07 - 0.03;
      lean = 1.03;
      breath = 0.25 + level * 0.75;
      heat = 0.75 + level * 0.5;
    }

    if (forge) {
      // Drawing a card: head down and turned to where the fire lands, jaws wide, burning hot.
      yaw = clamp(forge.x / (state.R * 2.4), -1, 1) * 0.62;
      pitch = REST_PITCH - 0.34;
      roll = -yaw * 0.14;
      jaw = 0.5 + 0.05 * Math.sin(time / 90);
      lean = 1.05;
      eye = 0.85;
      breath = 1;
      heat = 1.35;
    }

    pose.yaw += (yaw - pose.yaw) * ease(260);
    pose.pitch += (pitch - pose.pitch) * ease(260);
    pose.roll += (roll - pose.roll) * ease(320);
    pose.jaw += (jaw - pose.jaw) * ease(70);
    pose.lean += (lean - pose.lean) * ease(280);
    pose.heat += (heat - pose.heat) * ease(260);
    pose.breath += (breath - pose.breath) * ease(140);

    if (time > nextBlink) {
      blinkStart = time;
      nextBlink = time + 2800 + Math.random() * 4200;
    }
    const sinceBlink = time - blinkStart;
    // The lid closes over 90 ms, then opens again over 150 ms.
    let lid = 1;
    if (sinceBlink < 90) lid = 1 - sinceBlink / 90;
    else if (sinceBlink < 240) lid = (sinceBlink - 90) / 150;
    pose.eye = eye * lid;
  }

  // ---------------------------------------------------------------- Projection

  let unit = 100;
  let cosYaw = 1,
    sinYaw = 0,
    cosPitch = 1,
    sinPitch = 0,
    cosRoll = 1,
    sinRoll = 0,
    cosJaw = 1,
    sinJaw = 0;
  // Results of place(): position as the camera sees it, then on screen.
  let viewX = 0,
    viewY = 0,
    viewZ = 0,
    outX = 0,
    outY = 0,
    outScale = 1;

  /** Model point to screen, through the jaw hinge, the turn of the head and the camera. */
  function place(x, y, z, jawed) {
    if (jawed && z > -0.1) {
      const weight = z >= 0.2 ? 1 : smooth((z + 0.1) / 0.3);
      const cos = weight === 1 ? cosJaw : Math.cos(pose.jaw * weight);
      const sin = weight === 1 ? sinJaw : Math.sin(pose.jaw * weight);
      const dy = y - HINGE_Y;
      const dz = z - HINGE_Z;
      y = HINGE_Y + dy * cos + dz * sin;
      z = HINGE_Z - dy * sin + dz * cos;
    }
    y -= PIVOT_Y;
    z -= PIVOT_Z;
    const rolledX = x * cosRoll - y * sinRoll;
    const rolledY = x * sinRoll + y * cosRoll;
    const pitchedY = rolledY * cosPitch - z * sinPitch;
    const pitchedZ = rolledY * sinPitch + z * cosPitch;
    viewX = rolledX * cosYaw + pitchedZ * sinYaw;
    viewY = pitchedY + PIVOT_Y;
    viewZ = -rolledX * sinYaw + pitchedZ * cosYaw + PIVOT_Z;
    project(viewX, viewY, viewZ);
  }
  function project(x, y, z) {
    outScale = CAMERA / (CAMERA - z);
    outX = x * outScale * unit;
    outY = y * outScale * unit;
  }

  const COUNT = VERTS.length;
  const SX = new Float32Array(COUNT);
  const SY = new Float32Array(COUNT);
  const CX = new Float32Array(COUNT);
  const CY = new Float32Array(COUNT);
  const CZ = new Float32Array(COUNT);

  // ---------------------------------------------------------------- Fire

  // How strongly the fire is drawn; 1 is full strength.
  const FIRE_STRENGTH = 0.5;
  const particles = [];
  let warmed = 0;
  let nextSnort = 5000;
  let born = -1;

  /** Soft round glows in each colour of a flame's life, drawn once and reused. */
  function sprites(table) {
    return table.map(([r, g, b]) => {
      const tile = document.createElement("canvas");
      tile.width = 64;
      tile.height = 64;
      const ink = tile.getContext("2d");
      const glow = ink.createRadialGradient(32, 32, 0, 32, 32, 32);
      glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
      glow.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, 0.45)`);
      glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ink.fillStyle = glow;
      ink.fillRect(0, 0, 64, 64);
      return tile;
    });
  }
  const FIRE_GLOW = sprites(FIRE);
  const WHITE_GLOW = sprites(WHITE);

  /** A point of light thrown out of focus: an even disc with a slightly brighter rim. */
  function disc([r, g, b]) {
    const tile = document.createElement("canvas");
    tile.width = 64;
    tile.height = 64;
    const ink = tile.getContext("2d");
    const light = ink.createRadialGradient(32, 32, 0, 32, 32, 31);
    light.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.5)`);
    light.addColorStop(0.72, `rgba(${r}, ${g}, ${b}, 0.55)`);
    light.addColorStop(0.9, `rgba(${r}, ${g}, ${b}, 0.9)`);
    light.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ink.fillStyle = light;
    ink.fillRect(0, 0, 64, 64);
    return tile;
  }
  const BOKEH = [
    [255, 182, 59],
    [255, 140, 29],
    [255, 210, 126],
    [255, 160, 42],
  ].map(disc);

  /**
   * kind "flame": a soft body of fire that rolls upward and burns out.
   * kind "ember": a small bright spark that outlives the flame and drifts away.
   */
  function emit(model, velocity, options) {
    if (particles.length > 700) return;
    place(model[0], model[1], model[2], false);
    particles.push({
      x: viewX,
      y: viewY,
      z: viewZ,
      vx: velocity[0],
      vy: velocity[1],
      vz: velocity[2],
      age: 0,
      life: options.life,
      size: options.size,
      kind: options.kind ?? "flame",
      white: Boolean(options.white),
      lift: options.lift ?? 0.0007,
      seed: Math.random() * 100,
    });
  }

  function feedFire(clock) {
    const rate = 3 + 3 * pose.heat;
    for (let i = 0; i < rate; i += 1) {
      // Mane: fire leaving the back of the skull all the way round, strongest over the crown.
      const angle = radians(-90 + (Math.random() + Math.random() - 1) * 135);
      const root = upper(5 + Math.floor(Math.random() * 2), angle);
      const out = normalise([root[0], root[1] - 0.1, 0]);
      const push = 0.002 + Math.random() * 0.004;
      emit(root, [out[0] * push, out[1] * push - 0.004, -0.004 - Math.random() * 0.006], {
        life: 38 + Math.random() * 40,
        size: 0.1 + Math.random() * 0.14,
      });
      if (Math.random() < 0.55) {
        emit(root, [out[0] * push * 2 + (Math.random() - 0.5) * 0.006, -0.006 - Math.random() * 0.01, -0.004], {
          kind: "ember",
          life: 70 + Math.random() * 90,
          size: 0.014 + Math.random() * 0.02,
          lift: 0.00025,
        });
      }
    }
    // Under the jaw.
    if (Math.random() < 0.6) {
      const root = lower(5, radians(20 + Math.random() * 140));
      emit(root, [root[0] * 0.01, 0.002, -0.006], { life: 34 + Math.random() * 26, size: 0.09 + Math.random() * 0.08 });
    }
    // Wisps trailing from the corners of the eyes.
    for (const eye of EYES) {
      if (Math.random() < 0.45) {
        const root = [0, 1, 2].map((axis) => eye.centre[axis] + eye.along[axis] * 0.9);
        emit(root, [eye.side * 0.005, -0.003, -0.003], {
          life: 22 + Math.random() * 18,
          size: 0.04 + Math.random() * 0.03,
          white: true,
          lift: 0.0003,
        });
      }
    }
    // Now and then it snorts a puff of sparks from its nostrils.
    if (clock > nextSnort) {
      nextSnort = clock + 4000 + Math.random() * 5000;
      for (const nostril of NOSTRILS) {
        for (let i = 0; i < 10; i += 1) {
          emit(
            nostril,
            [
              Math.sign(nostril[0]) * (0.006 + Math.random() * 0.01),
              0.004 + Math.random() * 0.006,
              0.012 + Math.random() * 0.014,
            ],
            {
              kind: "ember",
              life: 26 + Math.random() * 26,
              size: 0.012 + Math.random() * 0.012,
              lift: 0.0006,
            },
          );
        }
      }
    }
    // Breath: white-hot fire thrown out of the mouth, straight at the viewer.
    if (pose.breath > 0.08) {
      const count = Math.round(pose.breath * 4 + Math.random());
      for (let i = 0; i < count; i += 1) {
        emit(
          [(Math.random() - 0.5) * 0.12, 0.5 + pose.jaw * 0.25, 0.6],
          [
            (Math.random() - 0.5) * 0.02,
            0.004 + Math.random() * 0.012,
            0.03 + Math.random() * 0.035 * (0.5 + pose.breath),
          ],
          {
            life: 24 + Math.random() * 18,
            size: 0.06 + Math.random() * 0.06,
            white: true,
            lift: 0,
            kind: Math.random() < 0.3 ? "ember" : "flame",
          },
        );
      }
    }
  }

  function stepFire(step, clock) {
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const particle = particles[i];
      particle.age += step;
      if (particle.age >= particle.life || particle.z > CAMERA - 1.4) {
        particles.splice(i, 1);
        continue;
      }
      // Hot air rises, and the same slow eddies push every flame near them the same way,
      // which is what gathers loose particles into licking tongues.
      const eddy =
        Math.sin(particle.y * 5 + clock / 190 + particle.x * 3) * 0.0011 +
        Math.sin(particle.x * 9 - clock / 420 + particle.y * 2) * 0.0006;
      particle.vx += eddy * step * (particle.kind === "ember" ? 1.6 : 1);
      particle.vy -= particle.lift * step;
      particle.vx *= 1 - 0.03 * step;
      particle.vz *= 1 - 0.01 * step;
      particle.x += particle.vx * step;
      particle.y += particle.vy * step;
      particle.z += particle.vz * step;
    }
  }

  /** Draw the fire on one side of the head: behind it before the head, in front after. */
  function drawFire(pen, front, clock) {
    for (const particle of particles) {
      if (particle.z > -0.25 !== front) continue;
      const t = particle.age / particle.life;
      const table = particle.white ? WHITE : FIRE;
      const index = Math.min(table.length - 1, Math.floor((0.1 + 0.9 * t) * table.length));
      project(particle.x, particle.y, particle.z);
      const [r, g, b] = table[index];

      if (particle.kind === "ember") {
        // A spark: a hard bright grain that flickers, with a faint halo.
        const flicker = 0.55 + 0.45 * Math.sin(clock / 60 + particle.seed * 7);
        const grain = clamp(particle.size * unit * outScale, 1.2, 5);
        pen.globalAlpha = FIRE_STRENGTH * (1 - t) * flicker;
        pen.fillStyle = `rgb(${r}, ${g}, ${b})`;
        pen.fillRect(outX - grain / 2, outY - grain / 2, grain, grain);
        pen.globalAlpha = FIRE_STRENGTH * 0.35 * (1 - t) * flicker;
        pen.drawImage(FIRE_GLOW[index], outX - grain * 4, outY - grain * 4, grain * 8, grain * 8);
        continue;
      }

      // A flame: a soft body that swells as it leaves the head and thins as it climbs.
      const swell = t < 0.2 ? 0.6 + 2 * t : 1 - 0.75 * (t - 0.2);
      const size = Math.min(particle.size * swell * unit * outScale, unit * 0.5);
      const fade = t < 0.1 ? t / 0.1 : Math.pow(1 - t, 1.3);
      pen.globalAlpha = FIRE_STRENGTH * (particle.white ? 0.14 : 0.27) * fade;
      pen.drawImage(
        (particle.white ? WHITE_GLOW : FIRE_GLOW)[index],
        outX - size,
        outY - size * 1.25,
        size * 2,
        size * 2.5,
      );

      // The hologram shows through the fire as scan dashes: short level strokes that flicker.
      if (particle.seed < 34) {
        const flicker = Math.sin(clock / 45 + particle.seed * 11);
        if (flicker > 0.1) {
          const dash = Math.min(16, size * (0.25 + 0.5 * ((particle.seed * 0.37) % 1)));
          pen.globalAlpha = FIRE_STRENGTH * 0.75 * fade * flicker;
          pen.fillStyle = `rgb(${r}, ${g}, ${b})`;
          pen.fillRect(outX - dash / 2, Math.round(outY), dash, 1.2);
        }
      }
    }
    pen.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- Head

  const SHADE = new Float32Array(FACES.length);
  const RIM = new Float32Array(FACES.length);
  const BACK = new Uint8Array(FACES.length);

  function shadeFaces() {
    for (let i = 0; i < FACES.length; i += 1) {
      const f = FACES[i];
      const quad = f.d >= 0;
      const ax = CX[f.a],
        ay = CY[f.a],
        az = CZ[f.a];
      const bx = CX[f.b],
        by = CY[f.b],
        bz = CZ[f.b];
      const cx = CX[f.c],
        cy = CY[f.c],
        cz = CZ[f.c];
      let nx, ny, nz, mx, my, mz;
      if (quad) {
        const dx = CX[f.d],
          dy = CY[f.d],
          dz = CZ[f.d];
        const ux = cx - ax,
          uy = cy - ay,
          uz = cz - az;
        const vx = dx - bx,
          vy = dy - by,
          vz = dz - bz;
        nx = uy * vz - uz * vy;
        ny = uz * vx - ux * vz;
        nz = ux * vy - uy * vx;
        mx = (ax + bx + cx + dx) / 4;
        my = (ay + by + cy + dy) / 4;
        mz = (az + bz + cz + dz) / 4;
      } else {
        const ux = bx - ax,
          uy = by - ay,
          uz = bz - az;
        const vx = cx - ax,
          vy = cy - ay,
          vz = cz - az;
        nx = uy * vz - uz * vy;
        ny = uz * vx - ux * vz;
        nz = ux * vy - uy * vx;
        mx = (ax + bx + cx) / 3;
        my = (ay + by + cy) / 3;
        mz = (az + bz + cz) / 3;
      }
      const length = Math.hypot(nx, ny, nz);
      if (length < 1e-9) continue;
      const flip = f.sign / length;
      nx *= flip;
      ny *= flip;
      nz *= flip;
      // Towards the camera, which sits on the z axis.
      let ex = -mx,
        ey = -my,
        ez = CAMERA - mz;
      const reach = Math.hypot(ex, ey, ez);
      ex /= reach;
      ey /= reach;
      ez /= reach;
      // Nothing is hidden: the far side of the head shows through, only dimmer.
      let facing = nx * ex + ny * ey + nz * ez;
      BACK[i] = facing <= 0 && !f.double ? 1 : 0;
      if (facing <= 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
        facing = -facing;
      }
      SHADE[i] = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
      RIM[i] = Math.pow(1 - facing, 2.5);
    }
  }

  /** Broken arcs round each cross-section of the head, rays along it, and the edges of horns and teeth. */
  function drawLines(pen, time) {
    const scale = unit / 220;
    const wave = (time / 240) % 22;
    const scan = Math.floor((time / 300) % 30);
    const dashes = [
      [14, 6, 3, 6],
      [30, 8],
      [4, 5],
      [50, 10, 6, 10],
      [9, 14],
    ];
    for (const line of LINES) {
      const ids = line.ids;
      pen.beginPath();
      pen.moveTo(SX[ids[0]], SY[ids[0]]);
      for (let i = 1; i < ids.length - 1; i += 1) {
        const here = ids[i];
        const next = ids[i + 1];
        pen.quadraticCurveTo(SX[here], SY[here], (SX[here] + SX[next]) / 2, (SY[here] + SY[next]) / 2);
      }
      pen.lineTo(SX[ids[ids.length - 1]], SY[ids[ids.length - 1]]);

      if (line.kind === "ring") {
        // A wave of light and a white scan both travel from the nose to the back of the skull.
        const pulse = Math.max(0, 1 - Math.abs(line.index - wave) / 1.6);
        const lit = line.index === scan;
        pen.setLineDash(dashes[line.index % dashes.length].map((length) => length * scale));
        pen.lineDashOffset = time * 0.012 * scale * (line.index % 2 ? 1 : -1) * (1 + (line.index % 3));
        pen.strokeStyle = lit
          ? "rgba(255, 232, 193, 0.95)"
          : `rgba(255, ${Math.round(166 + 50 * pulse)}, ${Math.round(58 + 100 * pulse)}, ${(0.4 + 0.45 * pulse).toFixed(3)})`;
        pen.lineWidth = lit ? 1.6 : 1.2;
        pen.stroke();
        // Every third arc is a band: the same arc again just inside and outside, in a finer rhythm.
        if (line.index % 3 === 1) {
          let midX = 0;
          let midY = 0;
          for (const id of ids) {
            midX += SX[id] / ids.length;
            midY += SY[id] / ids.length;
          }
          for (const grow of [0.955, 1.045]) {
            pen.beginPath();
            ids.forEach((id, n) => {
              const x = midX + (SX[id] - midX) * grow;
              const y = midY + (SY[id] - midY) * grow;
              if (n === 0) pen.moveTo(x, y);
              else pen.lineTo(x, y);
            });
            pen.setLineDash([2 * scale, 3 * scale]);
            pen.strokeStyle = `rgba(255, 158, 50, ${(0.4 + 0.4 * pulse).toFixed(3)})`;
            pen.lineWidth = 1;
            pen.stroke();
          }
        }
        continue;
      } else if (line.kind === "ray") {
        pen.setLineDash([]);
        pen.strokeStyle = "rgba(255, 149, 50, 0.22)";
        pen.lineWidth = 0.8;
      } else if (line.kind === "rib") {
        pen.setLineDash([6 * scale, 5 * scale]);
        pen.strokeStyle = "rgba(255, 158, 59, 0.3)";
        pen.lineWidth = 1;
      } else if (line.kind === "tooth") {
        pen.setLineDash([]);
        pen.strokeStyle = "rgba(255, 199, 118, 0.38)";
        pen.lineWidth = 1;
      } else {
        // Edges of the brows and horns: a soft glow under a bright line.
        pen.setLineDash([]);
        pen.strokeStyle = "rgba(255, 140, 34, 0.22)";
        pen.lineWidth = 5;
        pen.stroke();
        pen.strokeStyle = "rgba(255, 199, 118, 0.7)";
        pen.lineWidth = 1.1;
      }
      pen.stroke();
    }
    pen.setLineDash([]);
  }

  // Points are drawn in batches of one colour each, from dim amber to nearly white.
  const WARM = 8;
  const BATCHES = Array.from({ length: WARM }, () => []);
  const BATCH_CSS = Array.from({ length: WARM }, (_, k) => {
    const [r, g, b] = HOLO[Math.round(((k + 0.5) / WARM) * 63)];
    return `rgba(${r}, ${g}, ${b}, ${(0.24 + 0.56 * (k / (WARM - 1))).toFixed(2)})`;
  });

  /** The cloud of points that gives the head its shape: bright along its edges, faint where it turns away. */
  function drawCloud(pen, time) {
    for (const batch of BATCHES) batch.length = 0;
    const wave = (time / 240) % 22;
    const grain = Math.sqrt(unit / 220);
    for (let i = 0; i < CLOUD.length; i += STRIDE) {
      const index = CLOUD[i + 4];
      const f = FACES[index];
      place(CLOUD[i], CLOUD[i + 1], CLOUD[i + 2], CLOUD[i + 3] === 1);
      const twinkle = 0.62 + 0.38 * Math.sin(time / 330 + CLOUD[i + 5] * TAU);
      const pulse = f.kind === "skin" ? Math.max(0, 1 - Math.abs(f.row - wave) / 1.6) : 0;
      let value = clamp(
        (0.3 + 0.3 * SHADE[index] + 0.75 * RIM[index] + 0.45 * pulse + (pose.heat - 0.5) * 0.25) * twinkle,
      );
      if (BACK[index]) {
        // The far side shows through, but thinly and dimly, so it does not muddle the face.
        if (CLOUD[i + 5] > 0.45) continue;
        value *= 0.3;
      } else if (f.kind === "tooth") {
        // Teeth stay faint, so the mouth reads as light rather than as solid fangs.
        value *= 0.6;
      } else if (f.kind === "horn" && f.along > 0.6) {
        // The tips of horns and spikes burn brightest.
        value = clamp(value + 0.3);
      }
      const batch = Math.min(WARM - 1, Math.floor(value * WARM));
      const size = (1 + 1.7 * CLOUD[i + 6]) * outScale * grain;
      BATCHES[batch].push(outX - size / 2, outY - size / 2, size);

      // One point in a few is thrown out of focus into a soft disc of light.
      if ((i / STRIDE) % 17 === 0) {
        const soft = (2.5 + 7 * CLOUD[i + 6]) * outScale * grain * (0.7 + Math.abs(viewZ - 0.4));
        pen.globalAlpha = 0.4 * value;
        pen.drawImage(BOKEH[(i / STRIDE) % BOKEH.length], outX - soft, outY - soft, soft * 2, soft * 2);
      }
    }
    pen.globalAlpha = 1;
    BATCHES.forEach((batch, k) => {
      if (!batch.length) return;
      pen.fillStyle = BATCH_CSS[k];
      pen.beginPath();
      for (let n = 0; n < batch.length; n += 3) pen.rect(batch[n], batch[n + 1], batch[n + 2], batch[n + 2]);
      pen.fill();
    });
  }

  /** Circuit traces: short right-angled runs across the surface, each ending in a contact. */
  function drawGlyphs(pen, time) {
    pen.lineWidth = 1;
    for (const glyph of GLYPHS) {
      const live = Math.max(0, Math.sin(time / 420 + glyph.phase));
      if (live < 0.05) continue;
      const scale = (CAMERA / (CAMERA - CZ[glyph.vertex])) * (unit / 220);
      let x = SX[glyph.vertex];
      let y = SY[glyph.vertex];
      pen.beginPath();
      pen.moveTo(x, y);
      for (const [dx, dy] of glyph.steps) {
        x += dx * scale;
        y += dy * scale;
        pen.lineTo(x, y);
      }
      pen.strokeStyle = `rgba(255, 199, 118, ${(0.75 * live).toFixed(3)})`;
      pen.stroke();
      pen.fillStyle = `rgba(255, 227, 181, ${live.toFixed(3)})`;
      pen.fillRect(x - 1.5 * scale, y - 1.5 * scale, 3 * scale, 3 * scale);
    }
  }

  // Motes of light drifting round the head: [angle, radius, height, speed, size, trace].
  const DUST = Array.from({ length: 150 }, (_, i) => {
    let trace = null;
    if (i % 5 === 0) {
      // Some carry a circuit trace: a few right-angled steps ending in a contact.
      trace = [];
      let across = Math.random() < 0.5;
      for (let n = 4 + Math.floor(Math.random() * 5); n > 0; n -= 1) {
        const reach = (3 + Math.random() * 12) * (Math.random() < 0.5 ? -1 : 1);
        trace.push(across ? [reach, 0] : [0, reach]);
        across = !across;
      }
    }
    return [
      Math.random() * TAU,
      0.45 + Math.pow(Math.random(), 0.7) * 1.15,
      (Math.random() - 0.5) * 2.3,
      0.4 + Math.random(),
      Math.random(),
      trace,
    ];
  });

  /** Out-of-focus discs of light, larger the further they sit from the plane of the face. */
  function drawDust(pen, time) {
    const grain = unit / 220;
    for (let i = 0; i < DUST.length; i += 1) {
      const [angle, radius, height, speed, size, trace] = DUST[i];
      const turn = angle + (time / 9000) * speed;
      place(
        Math.cos(turn) * radius,
        height + 0.08 * Math.sin(time / 1300 + angle * 5),
        Math.sin(turn) * radius * 0.9 - 0.1,
        false,
      );
      const twinkle = 0.5 + 0.5 * Math.sin(time / 300 + angle * 40);
      const blur = Math.abs(viewZ - 0.3);
      const soft = (1.5 + 5 * size * size + 9 * blur * size) * outScale * grain;
      pen.globalAlpha = (0.2 + 0.5 * twinkle) / (1 + blur * 1.2);
      pen.drawImage(BOKEH[i % BOKEH.length], outX - soft, outY - soft, soft * 2, soft * 2);
      if (trace && twinkle > 0.3) {
        let x = outX;
        let y = outY;
        pen.beginPath();
        pen.moveTo(x, y);
        for (const [dx, dy] of trace) {
          x += dx * grain * outScale;
          y += dy * grain * outScale;
          pen.lineTo(x, y);
        }
        pen.globalAlpha = 0.7 * (twinkle - 0.3);
        pen.strokeStyle = "rgb(255, 191, 92)";
        pen.lineWidth = 1;
        pen.stroke();
        pen.fillStyle = "rgb(255, 219, 160)";
        pen.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
    pen.globalAlpha = 1;
  }

  // Slow rings circling the head: [radius, tilt about x, tilt about z, turns per minute, dash pattern, band width, part of the circle drawn].
  const ORBITS = [
    [1.02, 1.25, 0.2, 1.1, [2, 3], 0.05, 0.78],
    [1.2, 1.05, -0.5, -0.7, [18, 4, 3, 4], 0.03, 0.6],
    [1.38, 1.4, 0.75, 0.5, [1, 4], 0.07, 0.86],
    [1.55, 0.8, -0.15, -0.35, [40, 8, 2, 8], 0.02, 0.5],
    [0.8, 1.5, 1.2, 1.6, [3, 2, 9, 2], 0.04, 0.7],
  ];

  function drawOrbits(pen, time) {
    const grain = unit / 220;
    ORBITS.forEach(([radius, tiltX, tiltZ, speed, dash, band, part], k) => {
      const spin = (time / 60000) * speed * TAU + k * 1.9;
      const cosX = Math.cos(tiltX),
        sinX = Math.sin(tiltX),
        cosZ = Math.cos(tiltZ),
        sinZ = Math.sin(tiltZ);
      // A band is the same arc drawn three times at slightly different radii and dash rhythms.
      for (let lane = 0; lane < 3; lane += 1) {
        const reach = radius * (1 + (lane - 1) * band);
        pen.beginPath();
        const steps = Math.round(72 * part);
        for (let n = 0; n <= steps; n += 1) {
          const angle = spin + (n / 72) * TAU;
          const flatX = Math.cos(angle) * reach;
          const flatZ = Math.sin(angle) * reach;
          const y = -flatZ * sinX;
          const z = flatZ * cosX;
          place(flatX * cosZ - y * sinZ, flatX * sinZ + y * cosZ + 0.05, z + 0.05, false);
          if (n === 0) pen.moveTo(outX, outY);
          else pen.lineTo(outX, outY);
        }
        pen.setLineDash(dash.map((length) => length * grain * (1 + lane * 0.6)));
        pen.lineDashOffset = lane * 7;
        pen.strokeStyle = `rgba(255, ${174 - lane * 22}, ${64 - lane * 16}, ${(0.9 - lane * 0.14).toFixed(2)})`;
        pen.lineWidth = lane === 1 ? 2 : 1.3;
        pen.stroke();
      }
    });
    pen.setLineDash([]);
  }

  // Thin rays crossing at a point between the eyes: [direction, how far each way, phase].
  const FOCUS = [0, -0.08, 0.5];
  const RAYS = Array.from({ length: 18 }, () => {
    const direction = normalise([Math.random() - 0.5, Math.random() - 0.5, (Math.random() - 0.5) * 0.6]);
    return [direction, 1.2 + Math.random() * 1.1, Math.random() * 100];
  });

  function drawRays(pen, time) {
    for (const [direction, reach, phase] of RAYS) {
      const live = 0.4 + 0.6 * Math.max(0, Math.sin(time / 900 + phase));
      place(FOCUS[0] - direction[0] * reach, FOCUS[1] - direction[1] * reach, FOCUS[2] - direction[2] * reach, false);
      const fromX = outX;
      const fromY = outY;
      place(FOCUS[0] + direction[0] * reach, FOCUS[1] + direction[1] * reach, FOCUS[2] + direction[2] * reach, false);
      const ray = pen.createLinearGradient(fromX, fromY, outX, outY);
      ray.addColorStop(0, "rgba(255, 158, 50, 0)");
      ray.addColorStop(0.5, `rgba(255, 199, 109, ${(0.5 * live).toFixed(3)})`);
      ray.addColorStop(1, "rgba(255, 158, 50, 0)");
      pen.beginPath();
      pen.moveTo(fromX, fromY);
      pen.lineTo(outX, outY);
      pen.strokeStyle = ray;
      pen.lineWidth = 0.8;
      pen.stroke();
      // A bead of light runs out along each ray.
      const along = ((time / 2600 + phase) % 1) * 2 - 1;
      place(
        FOCUS[0] + direction[0] * reach * along,
        FOCUS[1] + direction[1] * reach * along,
        FOCUS[2] + direction[2] * reach * along,
        false,
      );
      pen.fillStyle = `rgba(255, 223, 168, ${(0.9 * (1 - Math.abs(along))).toFixed(3)})`;
      pen.fillRect(outX - 1.2, outY - 1.2, 2.4, 2.4);
    }
  }

  /**
   * The outline of an eye: two shallow curves meeting in a point at each corner, like a
   * reptile's. The upper lid is the flatter of the two, which is what makes it glare.
   */
  function eyeOutline(pen, eye, scale, open) {
    const steps = 14;
    pen.beginPath();
    for (let step = 0; step <= steps * 2; step += 1) {
      const onUpperLid = step <= steps;
      const t = onUpperLid ? -1 + (2 * step) / steps : 1 - (2 * (step - steps)) / steps;
      const bulge = (1 - t * t) * scale * open;
      const down = onUpperLid ? -0.6 * bulge : 0.95 * bulge;
      const along = t * scale;
      place(
        eye.centre[0] + eye.along[0] * along + eye.down[0] * down,
        eye.centre[1] + eye.along[1] * along + eye.down[1] * down,
        eye.centre[2] + eye.along[2] * along + eye.down[2] * down,
        false,
      );
      if (step === 0) pen.moveTo(outX, outY);
      else pen.lineTo(outX, outY);
    }
    pen.closePath();
  }

  function drawEye(pen, eye) {
    // Skip an eye that has turned away from the camera.
    place(eye.centre[0], eye.centre[1], eye.centre[2], false);
    const cx = viewX,
      cy = viewY,
      cz = viewZ,
      scale = outScale;
    place(eye.centre[0] + eye.side * 0.02, eye.centre[1] - 0.05, eye.centre[2] + 0.1, false);
    if ((viewX - cx) * -cx + (viewY - cy) * -cy + (viewZ - cz) * (CAMERA - cz) <= 0) return;

    // The iris sits a little below the middle, where the eye is deepest, and slides
    // towards whatever the head is looking at.
    const slide = clamp(pose.yaw / 0.5, -1, 1) * 0.2 * eye.side;
    place(
      eye.centre[0] + eye.along[0] * slide + eye.down[0] * 0.18,
      eye.centre[1] + eye.along[1] * slide + eye.down[1] * 0.18,
      eye.centre[2] + eye.along[2] * slide + eye.down[2] * 0.18,
      false,
    );
    const midX = outX;
    const midY = outY;
    const open = Math.max(0.04, pose.eye);
    const round = 0.05 * unit * scale;

    // A faint shadow under the eye so it does not get lost among the points around it.
    pen.globalCompositeOperation = "source-over";
    eyeOutline(pen, eye, 1.12, open);
    pen.fillStyle = "rgba(8, 5, 2, 0.28)";
    pen.fill();
    pen.globalCompositeOperation = "lighter";

    // The eye itself is a wash of light, not a solid shape: the head shows through it.
    const wash = pen.createRadialGradient(midX, midY, 0, midX, midY, round * 2.4);
    wash.addColorStop(0, "rgba(255, 250, 235, 0.5)");
    wash.addColorStop(0.45, "rgba(255, 214, 140, 0.3)");
    wash.addColorStop(1, "rgba(255, 138, 20, 0.14)");
    eyeOutline(pen, eye, 1, open);
    pen.fillStyle = wash;
    pen.fill();
    pen.strokeStyle = "rgba(255, 226, 170, 0.85)";
    pen.lineWidth = 1.2;
    pen.stroke();

    // Inside the lids: a round iris drawn as rings of light, and a slit pupil.
    pen.save();
    eyeOutline(pen, eye, 1, open);
    pen.clip();
    pen.globalAlpha = 0.2 + 0.14 * pose.heat;
    pen.drawImage(WHITE_GLOW[3], midX - round * 2.6, midY - round * 2.6, round * 5.2, round * 5.2);
    pen.globalAlpha = 1;
    pen.strokeStyle = "rgba(255, 214, 140, 0.9)";
    pen.lineWidth = 1.2;
    pen.beginPath();
    pen.arc(midX, midY, round, 0, TAU);
    pen.stroke();
    pen.setLineDash([2, 2]);
    pen.strokeStyle = "rgba(255, 190, 96, 0.7)";
    pen.lineWidth = 1;
    pen.beginPath();
    pen.arc(midX, midY, round * 0.62, 0, TAU);
    pen.stroke();
    pen.setLineDash([]);
    pen.globalCompositeOperation = "source-over";
    pen.fillStyle = "rgba(10, 5, 2, 0.65)";
    pen.beginPath();
    pen.ellipse(midX, midY, round * 0.2, round * 0.95, pose.roll, 0, TAU);
    pen.fill();
    pen.restore();
    pen.globalCompositeOperation = "lighter";
  }

  function drawNostril(pen, nostril) {
    place(nostril[0], nostril[1], nostril[2], false);
    const radius = 0.026 * unit * outScale;
    pen.beginPath();
    pen.ellipse(outX, outY, radius, radius * 0.45, pose.roll - Math.sign(nostril[0]) * 0.7, 0, TAU);
    pen.strokeStyle = `rgba(255, 177, 92, ${0.5 + 0.4 * pose.heat})`;
    pen.lineWidth = 1.2;
    pen.stroke();
  }

  function drawWhisker(pen, whisker, time, side) {
    pen.beginPath();
    whisker.forEach((point, j) => {
      const along = j / (whisker.length - 1);
      const sway = 0.07 * along * along * Math.sin(time / 420 - along * 4 + side);
      place(point[0], point[1] + sway, point[2] + sway * 0.6, false);
      if (j === 0) pen.moveTo(outX, outY);
      else pen.lineTo(outX, outY);
    });
    pen.lineCap = "round";
    pen.strokeStyle = "rgba(255, 140, 34, 0.3)";
    pen.lineWidth = 6;
    pen.stroke();
    pen.strokeStyle = "rgba(255, 210, 134, 0.95)";
    pen.lineWidth = 1.5;
    pen.stroke();
  }

  // Features drawn over the cloud.
  const EXTRAS = [
    ...EYES.map((eye) => ({
      at: [eye.centre[0], eye.centre[1], eye.centre[2] + 0.06],
      draw: (pen) => drawEye(pen, eye),
    })),
    ...NOSTRILS.map((nostril) => ({
      at: [nostril[0], nostril[1], nostril[2] + 0.08],
      draw: (pen) => drawNostril(pen, nostril),
    })),
    ...WHISKERS.map((whisker, i) => ({
      at: [whisker[12][0], whisker[12][1], whisker[12][2]],
      draw: (pen, time) => drawWhisker(pen, whisker, time, i * 2),
    })),
  ];

  function drawHead(pen, time) {
    for (let i = 0; i < COUNT; i += 1) {
      const point = VERTS[i];
      place(point[0], point[1], point[2], point[3] === 1);
      SX[i] = outX;
      SY[i] = outY;
      CX[i] = viewX;
      CY[i] = viewY;
      CZ[i] = viewZ;
    }
    shadeFaces();

    pen.lineJoin = "round";
    pen.globalCompositeOperation = "lighter";

    // The throat glows, and turns white-hot when it breathes fire.
    place(0, 0.5 + pose.jaw * 0.2, 0.35, false);
    const throat = (0.3 + pose.jaw * 0.5 + pose.breath * 0.3) * unit * outScale;
    pen.globalAlpha = clamp(0.18 + pose.jaw * 0.4 + pose.breath * 0.25);
    pen.drawImage(
      pose.breath > 0.3 ? WHITE_GLOW[4] : FIRE_GLOW[6],
      outX - throat,
      outY - throat,
      throat * 2,
      throat * 2,
    );
    pen.globalAlpha = 1;

    drawRays(pen, time);
    drawOrbits(pen, time);
    drawLines(pen, time);
    drawCloud(pen, time);
    drawGlyphs(pen, time);
    for (const extra of EXTRAS) extra.draw(pen, time);
    pen.globalCompositeOperation = "lighter";
    drawDust(pen, time);
    pen.globalCompositeOperation = "source-over";
  }

  /**
   * Draw one frame, centred on the current origin of `pen`.
   * state: { R, time, elapsed, still, phase, loudness, voiced, forge }
   * `forge` is where fire is landing on the board, relative to the origin, or null.
   * Afterwards `api.mouth` holds where the mouth was drawn, relative to the same origin.
   */
  function draw(pen, state) {
    if (!centre) {
      const box = pen.canvas.getBoundingClientRect();
      centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    updatePose(state);
    // `hold` pins the pose, for checking a single frame in a screenshot.
    if (api.hold) Object.assign(pose, api.hold);

    // It ignites when the app opens: growing into place as the fire catches.
    if (born < 0) born = performance.now();
    const intro = state.still ? 1 : smooth((performance.now() - born) / 1500);
    if (intro < 1) pose.heat += (1 - intro) * 0.8;
    unit =
      state.R *
      SIZE *
      pose.lean *
      (0.72 + 0.28 * intro) *
      (1 + (state.still ? 0 : 0.012 * Math.sin(state.time / 1500)));
    cosYaw = Math.cos(pose.yaw);
    sinYaw = Math.sin(pose.yaw);
    cosPitch = Math.cos(pose.pitch);
    sinPitch = Math.sin(pose.pitch);
    cosRoll = Math.cos(pose.roll);
    sinRoll = Math.sin(pose.roll);
    cosJaw = Math.cos(pose.jaw);
    sinJaw = Math.sin(pose.jaw);
    place(0, 0.52 + pose.jaw * 0.2, 0.5, false);
    api.mouth = { x: outX, y: outY };

    // With reduced motion the fire is lit once and then held still.
    if (!state.still || warmed < 70) {
      const step = state.still ? 1 : clamp(state.elapsed / 16, 0, 3);
      feedFire(state.time);
      stepFire(step, state.time);
      warmed += 1;
    }

    pen.save();
    pen.shadowBlur = 0;

    // A warm haze behind everything, as if the light were hanging in dusty air.
    pen.globalCompositeOperation = "lighter";
    for (const [y, z, size, colour, strength] of [
      [0.1, -0.2, 1.0, "255, 121, 17", 0.1 + 0.08 * pose.heat],
      [-0.2, -0.9, 1.6, "200, 80, 10", 0.1],
    ]) {
      place(0, y, z, false);
      const radius = size * unit * outScale;
      const haze = pen.createRadialGradient(outX, outY, 0, outX, outY, radius);
      haze.addColorStop(0, `rgba(${colour}, ${strength.toFixed(3)})`);
      haze.addColorStop(1, `rgba(${colour}, 0)`);
      pen.fillStyle = haze;
      pen.fillRect(outX - radius, outY - radius, radius * 2, radius * 2);
    }
    drawFire(pen, false, state.time);

    pen.globalCompositeOperation = "source-over";
    pen.globalAlpha = intro;
    drawHead(pen, state.time);
    pen.globalAlpha = 1;

    pen.globalCompositeOperation = "lighter";
    drawFire(pen, true, state.time);
    pen.restore();

    // Bloom: a small, blurred copy of the frame laid back over it, so every light has a halo.
    const canvas = pen.canvas;
    const wide = Math.max(1, canvas.width >> 2);
    const tall = Math.max(1, canvas.height >> 2);
    if (bloom.width !== wide || bloom.height !== tall) {
      bloom.width = wide;
      bloom.height = tall;
    }
    bloomInk.clearRect(0, 0, wide, tall);
    bloomInk.filter = "blur(3px)";
    bloomInk.drawImage(canvas, 0, 0, wide, tall);
    pen.save();
    pen.setTransform(1, 0, 0, 1, 0, 0);
    pen.globalCompositeOperation = "lighter";
    pen.globalAlpha = 0.32;
    pen.drawImage(bloom, 0, 0, canvas.width, canvas.height);
    pen.restore();
  }

  const bloom = document.createElement("canvas");
  const bloomInk = bloom.getContext("2d");

  const api = {
    draw,
    hold: null,
    mouth: null,
    /** The canvas has moved or changed size, so the pointer must be measured afresh. */
    moved() {
      centre = null;
    },
  };
  window.theoDragon = api;
})();
