/*
 * The forge: how cards arrive on the board.
 *
 * The dragon breathes a jet of fire down at each card in turn. Where the jet lands on the
 * card's top edge the fire splits and runs round the outline both ways, meeting at the
 * bottom; the outline is left glowing, then cools to the blue of the rest of the display
 * as the card's words appear. This file draws the jet, the running fire and the sparks on
 * a canvas laid over the stage. The cooling and the words are CSS, switched by
 * `data-forge` on each card: "wait", then "trace", then "set".
 *
 * All positions are in window coordinates, so the cards can move while they are drawn.
 */
(() => {
  "use strict";

  const canvas = document.getElementById("forge");
  const pen = canvas.getContext("2d");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  const TRACE_MS = 620;
  const AFTERGLOW_MS = 420;
  const TAU = Math.PI * 2;
  const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
  const mix = (a, b, t) => a + (b - a) * t;

  /** A soft round glow in one colour, drawn once and stamped many times. */
  function glow(r, g, b) {
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = 64;
    const ink = sprite.getContext("2d");
    const fill = ink.createRadialGradient(32, 32, 0, 32, 32, 32);
    fill.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
    fill.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, 0.45)`);
    fill.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ink.fillStyle = fill;
    ink.fillRect(0, 0, 64, 64);
    return sprite;
  }
  // White-hot at the mouth, gold in flight, orange where it lands and spreads.
  const HEAT = [glow(255, 240, 214), glow(255, 206, 101), glow(255, 149, 34), glow(240, 92, 14)];

  let jobs = [];
  let jet = [];
  let sparks = [];
  let dirty = false;
  let lastTime = 0;
  let frameBox = null;

  function settle(job) {
    job.done = true;
    job.card.dataset.forge = "set";
  }

  /**
   * Draw these cards, in order. `delay` holds the first one back, for when the board is
   * still opening.
   */
  function start(cards, { delay = 0 } = {}) {
    if (reducedMotion.matches) {
      for (const card of cards) card.dataset.forge = "set";
      return;
    }
    const now = performance.now();
    const pending = jobs.filter((job) => !job.done);
    const from = Math.max(now + delay, ...pending.map((job) => job.at + job.gap));
    // A long list is drawn faster, so the whole board takes about the same time.
    const gap = clamp(1500 / Math.max(1, cards.length), 90, 230);
    cards.forEach((card, index) => {
      card.dataset.forge = "wait";
      jobs.push({ card, at: from + index * gap, gap, entry: -1, done: false, doneAt: 0 });
    });
  }

  /** Finish at once: every card appears and the fire goes out. */
  function clear() {
    for (const job of jobs) if (!job.done) settle(job);
    jobs = [];
    jet = [];
    sparks = [];
  }

  /** Where the dragon should look and breathe: the card being started, or the next one. */
  function aim() {
    if (!jobs.length) return null;
    const now = performance.now();
    let target = null;
    for (const job of jobs) {
      if (job.done) continue;
      if (now >= job.at) {
        // The most recently started card, until its fire is well on its way round.
        if (now < job.at + TRACE_MS * 0.75) target = job;
      } else {
        // Nothing is being started right now: look ahead to the next card.
        target ??= job;
        break;
      }
    }
    if (!target) return null;
    const box = target.card.getBoundingClientRect();
    if (!box.width) return null;
    const along = target.entry >= 0 ? target.entry : 0.5;
    return { x: box.left + box.width * along, y: box.top, lit: now >= target.at };
  }

  /** The point `distance` along a box's outline, clockwise from its top-left corner. */
  function onOutline(box, distance) {
    const around = 2 * (box.width + box.height);
    let d = ((distance % around) + around) % around;
    if (d <= box.width) return [box.left + d, box.top];
    d -= box.width;
    if (d <= box.height) return [box.right, box.top + d];
    d -= box.height;
    if (d <= box.width) return [box.right - d, box.bottom];
    return [box.left, box.bottom - (d - box.width)];
  }

  /** Stroke the outline of `box` from one distance to another, turning at each corner. */
  function strokeOutline(box, from, to) {
    const around = 2 * (box.width + box.height);
    const corners = [0, box.width, box.width + box.height, 2 * box.width + box.height];
    pen.beginPath();
    pen.moveTo(...onOutline(box, from));
    for (let lap = Math.floor(from / around) - 1; lap <= Math.floor(to / around) + 1; lap += 1) {
      for (const corner of corners) {
        const at = corner + lap * around;
        if (at > from && at < to) pen.lineTo(...onOutline(box, at));
      }
    }
    pen.lineTo(...onOutline(box, to));
    pen.stroke();
  }

  function stamp(sprite, x, y, radius, alpha) {
    if (alpha <= 0.01) return;
    pen.globalAlpha = alpha;
    pen.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
  }

  function burst(x, y, count, speed) {
    if (sparks.length > 260) return;
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * TAU;
      const push = speed * (0.3 + Math.random());
      sparks.push({
        x,
        y,
        vx: Math.cos(angle) * push,
        vy: Math.sin(angle) * push - speed * 0.5,
        age: 0,
        life: 16 + Math.random() * 22,
      });
    }
  }

  /**
   * Draw one frame. `mouth` is where the dragon's mouth is, in window coordinates, or
   * null when the dragon is not on screen.
   */
  function render(time, mouth) {
    const busy = jobs.length || jet.length || sparks.length;
    if (!busy && !dirty) return;

    const ratio = devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) {
      // The stage is hidden: there is nothing to watch, so let the cards simply appear.
      clear();
      return;
    }
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const origin = canvas.getBoundingClientRect();
    pen.setTransform(ratio, 0, 0, ratio, -origin.left * ratio, -origin.top * ratio);
    pen.clearRect(origin.left, origin.top, width, height);
    dirty = Boolean(busy);
    if (!busy) return;

    const step = clamp((time - lastTime) / 16, 0.2, 3);
    lastTime = time;
    const now = performance.now();
    // Cards scrolled out of the board are not worth a jet of fire.
    frameBox = document.getElementById("board-body").getBoundingClientRect();

    pen.globalCompositeOperation = "lighter";
    pen.lineJoin = "round";
    pen.lineCap = "round";

    // Outlines show only inside the board, like the cards they belong to.
    pen.save();
    pen.beginPath();
    pen.rect(frameBox.left - 14, frameBox.top, frameBox.width + 28, frameBox.height);
    pen.clip();
    for (const job of jobs) {
      if (now < job.at) continue;
      const box = job.card.getBoundingClientRect();
      if (!job.done && (box.top > frameBox.bottom - 8 || box.bottom < frameBox.top || !box.width)) {
        settle(job);
        job.doneAt = now - AFTERGLOW_MS;
        continue;
      }
      if (job.entry < 0) {
        // The fire lands on the top edge, as near to under the mouth as the card allows.
        const landing = mouth ? clamp((mouth.x - box.left) / box.width, 0.12, 0.88) : 0.5;
        job.entry = landing;
        job.card.dataset.forge = "trace";
        burst(box.left + box.width * landing, box.top, 8, 2.2);
      }
      const around = 2 * (box.width + box.height);
      const landed = box.width * job.entry;
      const raw = clamp((now - job.at) / TRACE_MS);
      // The fire runs fast at first and slows as it closes the outline.
      const run = 1 - Math.pow(1 - raw, 2.2);
      const reach = (around / 2) * run;
      const fading = job.done ? clamp(1 - (now - job.doneAt) / AFTERGLOW_MS) : 1;

      // The outline so far: a wide soft glow under a thin bright line.
      pen.globalAlpha = 0.3 * fading;
      pen.strokeStyle = "rgb(255, 130, 24)";
      pen.lineWidth = 7;
      strokeOutline(box, landed - reach, landed + reach);
      pen.globalAlpha = 0.95 * fading;
      pen.strokeStyle = "rgb(255, 214, 140)";
      pen.lineWidth = 1.6;
      strokeOutline(box, landed - reach, landed + reach);

      if (!job.done) {
        // The two heads of the fire, white-hot, throwing sparks as they run.
        for (const head of [landed + reach, landed - reach]) {
          const [x, y] = onOutline(box, head);
          stamp(HEAT[2], x, y, 20, 0.5);
          stamp(HEAT[0], x, y, 9, 0.95);
          if (Math.random() < 0.55 * step) burst(x, y, 1, 1.4);
        }
        if (raw >= 1) {
          settle(job);
          job.doneAt = now;
          // Where the two fires meet, the outline closes with a flash.
          const [x, y] = onOutline(box, landed + around / 2);
          burst(x, y, 12, 2.6);
          stamp(HEAT[0], x, y, 26, 0.8);
        }
      }
    }
    pen.restore();
    jobs = jobs.filter((job) => !job.done || now - job.doneAt < AFTERGLOW_MS);

    // The jet: fire thrown from the mouth to where it lands.
    const target = aim();
    if (mouth && target && target.lit) {
      for (let i = 0; i < Math.round(4 * step + Math.random()); i += 1) {
        if (jet.length > 160) break;
        jet.push({
          t: 0,
          pace: 0.07 + Math.random() * 0.06,
          sway: (Math.random() - 0.5) * 2,
          seed: Math.random() * TAU,
          size: 0.7 + Math.random() * 0.6,
        });
      }
    }
    if (mouth && target) {
      const dx = target.x - mouth.x;
      const dy = target.y - mouth.y;
      const length = Math.hypot(dx, dy) || 1;
      const sideX = -dy / length;
      const sideY = dx / length;
      const spread = Math.min(26, length * 0.09);
      for (const flame of jet) {
        flame.t += flame.pace * step;
        if (flame.t >= 1) {
          if (Math.random() < 0.3) burst(target.x + flame.sway * 6, target.y, 1, 1.8);
          continue;
        }
        // Tight at the mouth, wider in the middle, gathered again where it lands.
        const belly = Math.sin(flame.t * Math.PI) * spread * flame.sway + Math.sin(time / 70 + flame.seed) * 2.5;
        const x = mouth.x + dx * flame.t + sideX * belly;
        const y = mouth.y + dy * flame.t + sideY * belly;
        let heat = 2;
        if (flame.t < 0.25) heat = 0;
        else if (flame.t < 0.6) heat = 1;
        stamp(HEAT[heat], x, y, mix(7, 19, flame.t) * flame.size, 0.42 * (1 - flame.t * 0.45));
      }
      jet = jet.filter((flame) => flame.t < 1);
      if (target.lit) {
        // A white core down the middle of the jet, flickering.
        const core = pen.createLinearGradient(mouth.x, mouth.y, target.x, target.y);
        core.addColorStop(0, "rgba(255, 244, 222, 0.75)");
        core.addColorStop(0.7, "rgba(255, 190, 90, 0.35)");
        core.addColorStop(1, "rgba(255, 150, 40, 0)");
        pen.globalAlpha = 0.5 + 0.3 * Math.sin(time / 38);
        pen.strokeStyle = core;
        pen.lineWidth = 3;
        pen.beginPath();
        pen.moveTo(mouth.x, mouth.y);
        pen.lineTo(target.x, target.y);
        pen.stroke();
        stamp(HEAT[1], target.x, target.y, 24, 0.5);
      }
    } else {
      jet = [];
    }

    // Sparks fall away and die.
    pen.fillStyle = "rgb(255, 206, 101)";
    for (const spark of sparks) {
      spark.age += step;
      spark.vy += 0.13 * step;
      spark.x += spark.vx * step;
      spark.y += spark.vy * step;
      const left = 1 - spark.age / spark.life;
      if (left <= 0) continue;
      pen.globalAlpha = left;
      pen.fillRect(spark.x - 0.9, spark.y - 0.9, 1.8, 1.8);
      stamp(HEAT[2], spark.x, spark.y, 5, left * 0.35);
    }
    sparks = sparks.filter((spark) => spark.age < spark.life);

    pen.globalAlpha = 1;
    pen.globalCompositeOperation = "source-over";
  }

  window.theoForge = { start, clear, aim, render, busy: () => jobs.some((job) => !job.done) };
})();
