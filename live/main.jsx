// Entry module: default export is the root component the bootstrap renders.
import Workspace from './app/Workspace.jsx';
import Chat, { SummonPill } from './chat/Chat.jsx';
import { Windows } from './ui/FloatingWindow.jsx';
import './net/index.js'; // multiplayer: sessions, sync, blobs
import { SessionPill } from './net/SessionWindow.jsx';
import { AssetsPill } from './net/AssetsWindow.jsx';
import { ChangesPill } from './net/ChangesWindow.jsx';
import { EnginePill } from './app/EnginePill.jsx';
import { FollowPill } from './app/FollowPill.jsx';
import { PrebakePill } from './app/PrebakePill.jsx';
import { PreviewFrame } from './app/PreviewFrame.jsx';
import { Guide } from './ui/guide/Guide.jsx';
import { TouchPills } from './app/TouchPills.jsx';
import { rememberScroll, storedScroll } from './ui/scrollMemory.js';
import { useRef, useEffect } from 'preact/hooks';
import './main.css';

// The pill row keeps its sideways scroll across reloads.
function PillRow({ children }) {
  const ref = useRef(null);
  useEffect(() => {
    const [saved, save] = storedScroll('redaw.pills.scroll');
    return rememberScroll(ref.current, saved, save);
  }, []);
  return (
    <div class="net-pills" ref={ref}>
      {children}
    </div>
  );
}

export default function App() {
  return (
    <div class="layout">
      <main class="layout-app">
        <Workspace />
      </main>
      <Windows />
      <PillRow>
        <TouchPills />
        <EnginePill />
        <FollowPill />
        <PrebakePill />
        <AssetsPill />
        <ChangesPill />
        <SessionPill />
        <SummonPill />
      </PillRow>
      <Chat />
      <PreviewFrame />
      <Guide />
    </div>
  );
}
