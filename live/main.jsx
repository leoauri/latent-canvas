// Entry module: default export is the root component the bootstrap renders.
import { persist } from '@live/runtime';
import Workspace from './app/Workspace.jsx';
import Chat from './chat/Chat.jsx';
import './main.css';

const chatOpen = persist('layout.chatOpen', true);

export default function App() {
  return (
    <div class={`layout${chatOpen.value ? '' : ' layout-chat-closed'}`}>
      <main class="layout-app">
        <Workspace />
      </main>
      <button class="layout-toggle" onClick={() => (chatOpen.value = !chatOpen.value)} title="Toggle chat">
        {chatOpen.value ? '›' : '‹'}
      </button>
      {chatOpen.value && <Chat />}
    </div>
  );
}
