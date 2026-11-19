import TimelineCanvas from './TimelineCanvas.jsx';
import Layers from './Layers.jsx';
import Playhead from './Playhead.jsx';
import Presence from './Presence.jsx';
import LayerStack from '../stack/LayerStack.jsx';
import { clips, selection, selectedId, duration } from './clips.js';
import './timeline.css';

export default function Timeline() {
  const sel = clips.value.find((c) => c.id === selectedId.value);
  const n = selection.value.filter((id) => clips.value.some((c) => c.id === id)).length;
  return (
    <div class="timeline">
      <TimelineCanvas />
      <Layers />
      <Playhead />
      <Presence />
      <LayerStack />
      <div class="timeline-hud">
        {n > 1
          ? `${n} clips · Drag: move · Alt+drag: copy · ⌘/Ctrl+D: duplicate · Delete: remove`
          : sel
            ? `${sel.length} samples × ${sel.dim} dims @ ${sel.rate} Hz · ${duration(sel).toFixed(2)} s · Alt+drag: copy · ⌘/Ctrl+D: duplicate`
            : 'Drag: move · Alt+drag: lasso (+Shift: add) · Click: place playhead · Space: play · Pinch: zoom · Shift+Space: agent chat (again, when empty: new chat)'}
      </div>
    </div>
  );
}
