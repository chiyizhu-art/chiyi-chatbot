import { useState } from 'react';
import Auth from './components/Auth';
import Chat from './components/Chat';
import './App.css';

function App() {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('chatapp_user');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : { username: String(parsed || '') };
    } catch {
      // Backward compatible: older app versions stored only the username string.
      return { username: raw, firstName: '', lastName: '' };
    }
  });

  const handleLogin = (nextUser) => {
    localStorage.setItem('chatapp_user', JSON.stringify(nextUser));
    setUser(nextUser);
  };

  const handleLogout = () => {
    localStorage.removeItem('chatapp_user');
    setUser(null);
  };

  if (user) {
    return <Chat user={user} onLogout={handleLogout} />;
  }
  return <Auth onLogin={handleLogin} />;
}

export default App;
