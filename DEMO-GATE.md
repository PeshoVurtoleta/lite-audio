# Demo heap gate

The `demo/` page makes a zero-GC claim in the one place it is easiest to break:
a live animation with a heap readout on screen. This file is how that claim is
verified. It is a manual gate - the suite under `test/` is `node:test` only and
the Law forbids a browser-driver dependency, so there is no automated headless
version. The gate is reproducible by hand in a few minutes.

The two claims:

1. **Every scene's frame loop allocates nothing.** No object, array, closure, or
   string is created per animation frame. This includes scene 5, whose orbiting
   source calls `setPosition(handle, x, y, z)` every frame - a zero-alloc scratch
   stamp on the caller frame (the PannerNode writes ride the shared ~10 Hz
   monitor), and whose trail is a preallocated ring, not a per-frame array. It also
   includes scene 6 (stereo width), whose goniometer reads the widened bus's two
   channels into two preallocated `Float32Array`s (`gonioL`/`gonioR`) per frame and
   reduces the L/R correlation with scalar accumulators - no per-frame array, no
   `toFixed` outside the throttle.
2. **Switching scenes allocates nothing.** No AnalyserNode, listener, or DOM node
   is created when you move between the six scenes, so a page left running does
   not climb. The two spatial buses (scene 5) are built once at engine boot, not
   on a switch; scene 6's channel splitter, its two per-channel analysers and their
   muted sink are built once in `attachScope()` and only re-connected to the new
   bus on a rebuild, so a scene switch never constructs them.

## Why it holds by construction

- All ring buffers, scope arrays, and the handle table are pre-allocated typed
  arrays, sized once at module load.
- The single `AnalyserNode` (the sfx-bus scope tap) and its muted sink are
  allocated once in `attachScope()` and reused across every rebuild - a scene
  switch never touches them. Scene 6's goniometer taps (a `ChannelSplitter` +
  two analysers + a muted sink on the widened bus) are built the same way, once,
  and only re-`connect`ed to the new `busNode` on a rebuild.
- Scene 6's sustained pad is a re-fired MONO SFX voice on the widened bus. The
  re-fire is cold - gated on `isPlaying`/ended in `drawWidth`, never a per-frame
  allocation - and the soak never sounds it (a per-iteration `play()` would steal
  a channel). Mono keeps the widener armed; a non-mono source would disarm it.
- Every `textContent` write is behind a `frameCount & TELEM_MASK` throttle
  (~7.5 Hz), and the strings it builds are the only per-write allocation the page
  makes; they are not in the draw path.
- Scene switching is an integer assignment plus `hidden` toggles. Nothing is
  constructed or destroyed.

Because nothing is created on a switch, the in-page soak and the DevTools
protocol below should both read flat.

## In-page soak (quick check, Chrome)

1. Launch Chrome with precise memory:
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --enable-precise-memory-info
   ```
   Without the flag `performance.memory` is bucketed to ~5 MB and the delta is
   noise; the button still runs but reports a coarse number.
2. Serve and open the page (see below), boot the engine.
3. Click **run soak (100 x switch)** in the footer. It selects all six scenes
   100 times (600 switches), drawing each once, and reports the used-heap delta.
   The soak draws scene 5's field and scene 6's goniometer but never sounds their
   voices (a per-iteration play() would steal a channel), so the alloc reading is
   not polluted by voice churn.
4. Expect a delta within a few hundred KB - dominated by the throttled log
   strings and GC timing, not by the loop. The readout turns red past 1 MB.

## DevTools protocol (the real gate)

The soak button is a smoke test. The authoritative check is a DevTools heap
profile, which is not fooled by `performance.memory` bucketing:

1. Open the page, boot the engine, unlock on scene 4, start a track on scene 3,
   strafe scene 1 so voices are live, and let scene 5 orbit an HRTF voice - the
   loop should be doing real work, including a per-frame `setPosition()`.
2. DevTools -> **Performance** -> record ~15 s while leaving one scene animating.
   In the **JS Heap** track, the sawtooth should be shallow and flat-topped: a
   rising baseline is a per-frame allocation leak.
3. DevTools -> **Memory** -> **Allocation instrumentation on timeline**. Record
   while switching scenes repeatedly. Blue allocation bars should appear only at
   the throttle interval (the log strings), never once per frame and never on the
   switch itself.
4. Take a heap snapshot, switch all six scenes ~50 times, force GC (the trash
   icon), take a second snapshot, and compare. Retained size should be flat and
   no detached `AnalyserNode` or `AudioNode` should appear in the delta.

## Serving

The page is single-file with an importmap; it needs no build step, but it does
need to be served (module scripts and `../Audio.js` do not load over `file://`).
From the package root:

```bash
npx serve .
```

then open `/demo/index.html`. The importmap resolves `@zakkster/lite-audio` to
`../Audio.js` and the two peers to `esm.sh`, so serve the package root, not the
`demo/` folder.

## What a failure looks like

- **Rising JS-heap baseline while one scene animates** - something in a `draw*`
  function is allocating. The usual culprits: a array/object literal per frame, a
  `toFixed` outside the throttle, or a closure passed to `forEach` in the loop.
- **Heap step on every scene switch** - `selectScene` or a draw path is creating
  a node or listener. It should not; taps live for the page's lifetime.
- **Detached AudioNodes in a snapshot delta** - a rebuild is leaking. `rebuild()`
  disposes every effect and calls `engine.destroy()`; the scope analyser is
  deliberately kept and re-connected, so it should never be detached.
