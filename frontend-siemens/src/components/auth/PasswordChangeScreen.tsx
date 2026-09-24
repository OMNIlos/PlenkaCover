import { useRef, useState, type FormEvent } from 'react';
import { changePassword } from '../../api/auth';

const LENGTH_ERROR = 'Пароль должен содержать от 4 до 128 символов.';
const MISMATCH_ERROR = 'Пароли не совпадают.';
const REQUEST_ERROR = 'Не удалось изменить пароль. Проверьте требования и повторите попытку.';

type SubmissionResult =
  | { status: 'success' }
  | { status: 'ignored' }
  | { status: 'error'; message: string };

export function validatePasswordChange(password: string, confirmation: string): string | null {
  if (password.length < 4 || password.length > 128) return LENGTH_ERROR;
  if (password !== confirmation) return MISMATCH_ERROR;
  return null;
}

export function createPasswordChangeSubmitter(
  change: (newPassword: string) => Promise<void>,
): (password: string, confirmation: string) => Promise<SubmissionResult> {
  let pending = false;
  return async (password, confirmation) => {
    const validationError = validatePasswordChange(password, confirmation);
    if (validationError) return { status: 'error', message: validationError };
    if (pending) return { status: 'ignored' };

    pending = true;
    try {
      await change(password);
      return { status: 'success' };
    } catch {
      return { status: 'error', message: REQUEST_ERROR };
    } finally {
      pending = false;
    }
  };
}

export function PasswordChangeScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitter = useRef<ReturnType<typeof createPasswordChangeSubmitter> | null>(null);
  if (!submitter.current) submitter.current = createPasswordChangeSubmitter(changePassword);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const result = await submitter.current!(password, confirmation);
    if (result.status === 'ignored') return;
    if (result.status === 'success') {
      setPassword('');
      setConfirmation('');
      setPending(false);
      onSuccess();
      return;
    }
    setError(result.message);
    setPending(false);
  }

  const validationError = validatePasswordChange(password, confirmation);

  return (
    <div className="auth-screen">
      <div className="auth-workspace">
        <form className="auth-card" onSubmit={handleSubmit}>
          <div className="auth-card-header">
            <span className="eyebrow">Безопасность</span>
            <h2>Новый пароль</h2>
            <p className="auth-hint">От 4 до 128 символов.</p>
          </div>
          <label className="auth-label">
            <span>Новый пароль</span>
            <input
              className="auth-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              minLength={4}
              maxLength={128}
              autoFocus
            />
          </label>
          <label className="auth-label">
            <span>Повторите пароль</span>
            <input
              className="auth-input"
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
              minLength={4}
              maxLength={128}
            />
          </label>
          {error ? (
            <div className="auth-error" aria-live="polite">
              {error}
            </div>
          ) : null}
          <button className="auth-button" type="submit" disabled={pending || Boolean(validationError)}>
            {pending ? 'Сохраняем…' : 'Сменить пароль'}
          </button>
        </form>
      </div>
    </div>
  );
}
