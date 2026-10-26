import { useState } from 'react';
import type { AuthState } from './auth';

export function LoginScreen({ auth }: { auth: AuthState }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const result = mode === 'signin'
      ? await auth.signIn(email, password)
      : await auth.signUp(email, password);
    setBusy(false);
    if (result.error) setError(result.error);
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1 className="login-title">Lecmap</h1>
        <p className="login-subtitle">Tus clases, en un mapa</p>

        <form onSubmit={submit} className="login-form">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="login-input"
          />
          <input
            type="password"
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="login-input"
          />
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-btn" disabled={busy}>
            {busy ? '...' : mode === 'signin' ? 'Iniciar sesión' : 'Crear cuenta'}
          </button>
        </form>

        <button className="login-google" onClick={() => auth.signInWithGoogle()}>
          Continuar con Google
        </button>

        <p className="login-switch">
          {mode === 'signin' ? '¿No tenés cuenta?' : '¿Ya tenés cuenta?'}{' '}
          <button
            type="button"
            className="login-link"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }}
          >
            {mode === 'signin' ? 'Registrate' : 'Iniciá sesión'}
          </button>
        </p>
      </div>
    </div>
  );
}
