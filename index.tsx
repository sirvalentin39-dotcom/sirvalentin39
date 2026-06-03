
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { loadSecrets } from './secrets';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

function renderLoading(message: string) {
  root.render(
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 text-center px-6">
      <div className="w-12 h-12 border-4 border-brand-primary/30 border-t-brand-primary rounded-full animate-spin"></div>
      <p className="text-brand-text-secondary text-sm">{message}</p>
    </div>
  );
}

function renderError(retry: () => void) {
  root.render(
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 text-center px-6">
      <p className="text-red-400 font-bold text-lg">Не вдалося завантажити застосунок</p>
      <p className="text-brand-text-secondary text-sm max-w-xs">
        Перевірте інтернет-з'єднання та спробуйте ще раз.
      </p>
      <button
        onClick={retry}
        className="bg-brand-primary hover:bg-brand-secondary text-white font-bold py-2.5 px-6 rounded-xl transition-colors"
      >
        Спробувати ще раз
      </button>
    </div>
  );
}

async function bootstrap() {
  renderLoading('Завантаження...');
  try {
    await loadSecrets();
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  } catch (err) {
    console.error('Помилка ініціалізації:', err);
    renderError(() => { bootstrap(); });
  }
}

bootstrap();
