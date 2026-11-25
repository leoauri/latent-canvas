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
import './main.css';

export default function App() {
  return (
    <div class="layout">
      <main class="layout-app">
        <Workspace />
      </main>
      <Windows />
      <div class="net-pills">
        <TouchPills />
        <EnginePill />
        <FollowPill />
        <PrebakePill />
        <AssetsPill />
        <ChangesPill />
        <SessionPill />
        <SummonPill />
      </div>
      <Chat />
      <PreviewFrame />
      <Guide />
    </div>
  );
}
