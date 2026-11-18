import TimelineCanvas from './TimelineCanvas.jsx';
import Layers from './Layers.jsx';
import Playhead from './Playhead.jsx';
import LayerStack from '../stack/LayerStack.jsx';
import { clips, selectedId, duration } from './clips.js';
import './timeline.css';

export default function Timeline() {
  const sel = clips.value.find((c) => c.id === selectedId.value);
  return (
    <div class="timeline">
      <TimelineCanvas />
      <Layers />
      <Playhead />
      <LayerStack />
      <div class="timeline-hud">
        {sel
          ? `${sel.length} samples × ${sel.dim} dims @ ${sel.rate} Hz · ${duration(sel).toFixed(2)} s`
          : 'Drag: move · Click: place playhead · Space: play · Pinch: zoom · Shift+Space: agent chat (again, when empty: new chat)'}
      </div>
    </div>
  );
}
