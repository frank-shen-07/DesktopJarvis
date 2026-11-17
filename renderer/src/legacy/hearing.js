/*
 * Hearing: deciding when someone is talking.
 *
 * While DesktopJarvis is idle the microphone stays open for the wake word. What it hears is cut
 * here into stretches of speech, and only a stretch that sounds like someone saying
 * something is sent off to be checked for the wake word:
 *
 * - The noise of the room is learnt as DesktopJarvis listens, so speech has to stand out from
 *   it: a fan or a busy café is not someone talking.
 * - A stretch has to hold at least one run of unbroken sound as long as a short word,
 *   so a click, a knock or a bump on the desk is not sent.
 * - A stretch ends only after a real pause, so "Jarvis... what's on today?" arrives as
 *   one request rather than two.
 * - Most of the quiet after the last word is cut off before it is sent, because speech
 *   recognisers invent words ("Thank you.") to fill silence.
 */
(() => {
  "use strict";

  // To start a stretch, sound has to be at least this loud, and this many times louder
  // than the room. Once started, a stretch carries on through anything above the lower
  // pair, so the softer parts of words and the gaps between them do not break it up.
  const START_LEVEL = 0.012;
  const START_ABOVE_ROOM = 2.2;
  const CARRY_ON_LEVEL = 0.01;
  const CARRY_ON_ABOVE_ROOM = 2;
  // Loud this long without a single quiet moment means the room itself got louder: a
  // fan, a vacuum, music. Nobody talks for this long without a breath.
  const STEADY_NOISE_MS = 20_000;

  /** How loud a run of samples is, as their root mean square. */
  function loudness(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return samples.length ? Math.sqrt(sum / samples.length) : 0;
  }

  /**
   * Follows the noise of the room, and says whether each moment stands out from it:
   * enough to start a stretch of speech, or, with `going`, enough to carry one on.
   */
  function createRoom() {
    // To begin with, only the fixed levels apply.
    let noise = CARRY_ON_LEVEL / CARRY_ON_ABOVE_ROOM;
    let loudFor = 0;
    const recent = [];
    return {
      hear(level, ms, going = false) {
        const carryOn = Math.max(CARRY_ON_LEVEL, noise * CARRY_ON_ABOVE_ROOM);
        const loud = going ? level > carryOn : level > Math.max(START_LEVEL, noise * START_ABOVE_ROOM);
        recent.push(level);
        if (recent.length > 64) recent.shift();
        if (level <= carryOn) {
          // Clearly not someone talking: this is what the room sounds like.
          noise += (level - noise) * 0.1;
          loudFor = 0;
        } else if ((loudFor += ms) > STEADY_NOISE_MS) {
          // Take the quieter moments of the last few seconds as the room's new level.
          noise = [...recent].sort((a, b) => a - b)[Math.floor(recent.length * 0.2)];
          loudFor = 0;
        }
        return loud;
      },
      get noise() {
        return noise;
      },
    };
  }

  /**
   * Cuts what the microphone hears into stretches of speech. Push each block of samples
   * as it arrives; a finished stretch comes back as a list of blocks, otherwise null.
   *
   * pauseMs: quiet that ends a stretch. longestMs: a stretch is cut off at this length.
   * leadMs: sound kept from before the first loud moment, so the first word is whole.
   * wordMs: the shortest run of unbroken sound that counts as a word.
   * tailMs: quiet kept after the last word.
   */
  function createSegmenter({ pauseMs, longestMs = 15_000, leadMs = 500, wordMs = 150, tailMs = 300 }) {
    const room = createRoom();
    let lead = [];
    let blocks = null;
    let quietMs = 0;
    let runMs = 0;
    let longestRunMs = 0;

    return {
      push(samples, sampleRate) {
        // The audio system reuses its buffers, so each block is copied.
        const block = Float32Array.from(samples);
        const ms = (block.length / sampleRate) * 1000;
        const loud = room.hear(loudness(block), ms, blocks !== null);

        if (!blocks) {
          lead.push(block);
          if (lead.length > Math.max(1, Math.round(leadMs / ms)) + 1) lead.shift();
          if (!loud) return null;
          blocks = lead;
          lead = [];
          quietMs = 0;
          runMs = longestRunMs = ms;
          return null;
        }

        blocks.push(block);
        if (loud) {
          runMs += ms;
          longestRunMs = Math.max(longestRunMs, runMs);
          quietMs = 0;
        } else {
          runMs = 0;
          quietMs += ms;
        }
        if (quietMs < pauseMs && blocks.length * ms < longestMs) return null;

        const heard = blocks;
        blocks = null;
        if (longestRunMs < wordMs) return null;
        const extra = Math.round(quietMs / ms) - Math.round(tailMs / ms);
        return extra > 0 ? heard.slice(0, heard.length - extra) : heard;
      },
      /** Forget anything half heard. The level of the room is kept. */
      clear() {
        lead = [];
        blocks = null;
      },
      get noise() {
        return room.noise;
      },
    };
  }

  window.theoHearing = { loudness, createRoom, createSegmenter };
})();
