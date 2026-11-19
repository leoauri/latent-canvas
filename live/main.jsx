// Entry module: default export is the root component the bootstrap renders.
import Workspace from './app/Workspace.jsx';
import Chat from './chat/Chat.jsx';
import { Windows } from './ui/FloatingWindow.jsx';
import './net/index.js'; // multiplayer: sessions, sync, blobs
import { SessionPill } from './net/SessionWindow.jsx';
import { AssetsPill } from './net/AssetsWindow.jsx';
import { ChangesPill } from './net/ChangesWindow.jsx';
import { PreviewFrame } from './app/PreviewFrame.jsx';
import { Guide } from './ui/guide/Guide.jsx';
import './main.css';

export default function App() {
  return (
    <div class="layout">
      <main class="layout-app">
        <Workspace />
      </main>
      <Windows />
      <div class="net-pills">
        <AssetsPill />
        <ChangesPill />
        <SessionPill />
      </div>
      <Chat />
      <PreviewFrame />
      <Guide />
    </div>
  );
}
