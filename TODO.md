# To do

## Design the window's dragon in Blender

Replace the code-drawn dragon in the middle of the Talk tab with a 3D model you design in
Blender. Once there is a model file, Claude can wire it in (see "Wiring it in" below).

### How the dragon works today

- It is drawn entirely by code: `renderer/src/legacy/dragon.js`, about 1,600 lines of maths.
  There is no model file; the head's shape is built from curves in that file.
- It is a **head facing the viewer**, drawn as a hologram of gold light: thousands of
  glowing points scattered over the head's surface, broken arcs, thin rays and slow rings.
  There are no solid surfaces, so only the model's _shape_ matters, not its colours or
  materials.
- Code moves it every frame. `app.js` calls `theoDragon.draw(...)` with the app's state:
  - the head **turns to follow the mouse pointer**;
  - it **blinks** now and then;
  - its **jaw moves with the voice** (how loud DesktopJarvis or the person is);
  - while cards are being drawn on the board it **looks down at them with its mouth wide
    open**, and `forge.js` draws a jet of fire from its mouth to each card.
- `forge.js` aims that fire from `theoDragon.mouth`, the mouth's position on screen. Whatever
  replaces the dragon has to keep reporting where its mouth is.

### Making the model in Blender

**Shape**

- Model a **head facing the camera**: in Blender's front view (numpad 1), the dragon looks
  straight back at you, out of the screen.
- Put the **origin in the middle of the skull** and make the head about **2 units wide**.
  Apply all transforms before exporting (select it, Ctrl+A, "All Transforms").
- Keep it light: **under about 50,000 triangles**. The hologram effect samples points on the
  surface, so detail beyond that will not show.
- Do not spend time on materials, colours or textures; the app draws its own glowing look.
  Spend it on the silhouette: horns, brow, snout, jaw.

**Moving parts.** The app drives these, so give them exactly these names. Shape keys are the
simplest way (Object Data properties → Shape Keys), and each goes from 0 (rest) to 1:

| Shape key | 0                  | 1                             | Driven by                      |
| --------- | ------------------ | ----------------------------- | ------------------------------ |
| `JawOpen` | mouth closed       | mouth wide open               | the voice, and breathing fire  |
| `Blink`   | eyes open          | eyes shut                     | a timer, every few seconds     |
| `Snarl`   | relaxed (optional) | lips pulled back, teeth bared | while it is working (optional) |

Turning the head to follow the pointer is done by rotating the whole model, so that needs
nothing from you.

**The mouth.** Add an **Empty** (Add → Empty → Plain Axes) named exactly `Mouth`, placed
where the fire should come out, and parent it to the head. The app reads its position to aim
the fire at the cards.

**Animation (optional).** A gentle looping idle animation (breathing, a slight sway) named
`Idle` will play underneath everything else. The model works without one.

### Exporting

File → Export → glTF 2.0, then:

- **Format:** glTF Binary (`.glb`)
- **Include:** Visible Objects (or Selected Objects), plus Custom Properties off
- **Transform:** +Y Up ticked (the default)
- **Data → Mesh:** Apply Modifiers ticked
- **Data → Shape Keys:** ticked
- **Animation:** ticked, if you made `Idle`

Save it as **`renderer/public/models/dragon.glb`** in this project.

To check the export before wiring it in, drag the `.glb` into a glTF viewer such as
https://gltf-viewer.donmccurdy.com/ and confirm it faces you, the shape keys appear and
move, and `Mouth` is listed.

### Wiring it in (ask Claude)

When `dragon.glb` exists, ask Claude to wire it in. The plan:

1. Add three.js and a `Dragon` React component under `renderer/src/components/Dragon/` that
   loads the model and draws it with the same hologram look (points, arcs, glow) in gold.
2. Drive it from the same state `dragon.js` gets today: pointer, voice loudness, phase,
   reduced motion and the fire's landing point, using `JawOpen`, `Blink` and `Snarl`.
3. Keep reporting the `Mouth` position so `forge.js` still aims the fire correctly.
4. Keep `dragon.js` as the fallback if the model file is missing or fails to load, and
   remove it once the new dragon is settled.
5. Compare screenshots of the Talk tab before and after, like the React move.

### Learning Blender

- **Blender Guru's "Donut" series** on YouTube is the standard place to start: the
  interface, modelling, and the basics of everything above.
- Search "Blender shape keys" for making `JawOpen` and `Blink`, and "Blender glTF export"
  for the export settings.
- Sculpting (Sculpt mode) is the most natural way to shape a creature's head; retopology
  is not needed for this, as long as it stays under the triangle budget.
