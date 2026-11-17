# The window (renderer)

Everything you see in the DesktopJarvis window lives here. It is built with three tools:

- **React** builds the page out of _components_: small, self-contained pieces such as the dock.
- **CSS Modules** give each component its own stylesheet that cannot leak into anything else.
- **Vite** serves the window while you work on it (changes show up as soon as you save) and
  bundles it for the packaged app.

## Working on it

```sh
npm run dev     # opens the app; saving a file in renderer/ updates the window straight away
npm run check   # lint, formatting and type checks, run before committing
```

Changes to `src/` at the top level (the main process: voice, mail, tools) need the app restarted.

## Where things are

```
renderer/
  index.html              the page's skeleton; React fills in the parts marked *-root
  src/
    main.tsx              the entry point: loads styles, the legacy code, and mounts components
    navigation.ts         which tab is showing; showView("settings") switches tabs from anywhere
    components/
      Dock/
        Dock.tsx          the dock's structure and behaviour
        Dock.module.css   the dock's styles, private to it
        icons.tsx         its icons
    styles/               shared stylesheets for areas not moved to components yet
      base.css            colours, fonts and the background; shared by everything
    legacy/               the original code, still running, moving into components bit by bit
      app.js              the rest of the interface
      dragon.js           the dragon, drawn by code
      forge.js            the fire that draws the cards
      hearing.js          listening for the wake word
```

## How a component works

Open `src/components/Dock/Dock.tsx`. A component is a function that returns what to draw, written
in JSX, which looks like HTML inside JavaScript:

```tsx
import styles from "./Dock.module.css";

export function Dock() {
  const current = useCurrentView(); // re-draws the dock whenever the tab changes
  return (
    <nav className={styles.dock}>
      {TABS.map(({ view, label }) => (
        <button className={styles.item} aria-current={view === current ? "page" : undefined}>
          {label}
        </button>
      ))}
    </nav>
  );
}
```

Differences from HTML to watch for: `className` instead of `class`, `strokeWidth` instead of
`stroke-width`, and `{ }` to put JavaScript values into the markup.

## How CSS Modules work

In `Dock.module.css` you write ordinary CSS with short, plain class names:

```css
.item {
  color: var(--muted);

  &:hover {
    color: var(--blue); /* `&` means "this same element", so this is .item:hover */
  }
}
```

In the component you use them through `styles`: `className={styles.item}`. When Vite builds the
app it renames `.item` to something unique like `._item_4rzvt_21`, so another component can have
its own `.item` and the two never affect each other. Only files ending in `.module.css` work this
way; the files in `src/styles/` are ordinary global CSS.

**Shared values** such as colours and fonts are CSS variables in `src/styles/base.css`
(`--blue`, `--edge`, `--label` and so on). Use them in components with `var(--blue)` so the whole
app stays consistent, and change them there to restyle everything at once.

## Moving another area into a component

The dock was moved first as the worked example. To move another area, say the Voice tab:

1. Make `src/components/VoicePanel/VoicePanel.tsx` and `VoicePanel.module.css`.
2. Copy its markup from `index.html` into the component as JSX, and replace the markup in
   `index.html` with `<div id="voice-root"></div>`.
3. Move its rules from `src/styles/voice.css` into the module, renaming `.voice-thing` to
   `.thing` and using `styles.thing` in the JSX. Delete `voice.css` and its import in `main.tsx`.
4. Move the code that drives it out of `legacy/app.js` into the component.
5. Mount it in `main.tsx` like the dock: `createRoot(document.getElementById("voice-root")!)`.
6. Run `npm run dev` to look at it, and `npm run check`.

Smaller, self-contained areas are the easiest to start with. The Talk tab and the board are the
most tangled with `app.js`, so leave them for last.
