// Entry module: default export is the root component the bootstrap renders.
import Workspace from './app/Workspace.jsx';
import Chat from './chat/Chat.jsx';
import './main.css';

export default function App() {
  return (
    <div class="layout">
      <main class="layout-app">
        <Workspace />
      </main>
      <Chat />
    </div>
  );
}
