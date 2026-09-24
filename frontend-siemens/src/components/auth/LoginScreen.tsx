import { useState, type FormEvent } from 'react';
import { login } from '../../api/auth';
import type { AuthSession } from '../../api/authStorage';

export function LoginScreen({
  notice,
  onSuccess,
}: {
  notice?: string | null;
  onSuccess: (session: AuthSession) => void;
}) {
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      onSuccess(await login(loginName.trim(), password));
    } catch {
      setError('Неверный логин или пароль');
      setPending(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-workspace">
        <form className="auth-card" onSubmit={handleSubmit}>
          <div className="auth-card-header">
            <span className="eyebrow">Доступ</span>
            <h2>Войти</h2>
          </div>
          <label className="auth-label">
            <span>Логин</span>
            <input
              className="auth-input"
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </label>
          <label className="auth-label">
            <span>Пароль</span>
            <input
              className="auth-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {notice ? <div className="auth-notice">{notice}</div> : null}
          {error ? <div className="auth-error">{error}</div> : null}
          <button className="auth-button" type="submit" disabled={pending || !loginName || !password}>
            {pending ? 'Входим…' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  );
}
