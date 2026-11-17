import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

type User = {
  id: string;
  email: string;
  createdAt: string;
  isAdmin: boolean;
  quotaSeconds: number | null;
};

type UsersAdminProps = {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onError: (message: string) => void;
  onClose: () => void;
};

function formatQuota(value: number | null): string {
  if (value === null || value === undefined) return 'default (2 h)';
  return `${value} s`;
}

function parseQuota(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

async function errorMessage(r: Response, fallback: string): Promise<string> {
  try {
    const body = await r.json();
    if (body && typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // cuerpo no JSON: usamos el fallback
  }
  return fallback;
}

export default function UsersAdmin({ apiFetch, onError, onClose }: UsersAdminProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [quotaDraft, setQuotaDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/admin/users');
      if (!r.ok) {
        throw new Error(await errorMessage(r, 'No se pudo cargar los usuarios'));
      }
      const data: unknown = await r.json();
      const list =
        data && typeof data === 'object' && Array.isArray((data as { users?: unknown }).users)
          ? (data as { users: unknown[] }).users
          : [];
      const parsed: User[] = list.map((item) => {
        const u = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        return {
          id: String(u.id ?? ''),
          email: String(u.email ?? ''),
          createdAt: String(u.createdAt ?? ''),
          isAdmin: Boolean(u.isAdmin),
          quotaSeconds: typeof u.quotaSeconds === 'number' ? u.quotaSeconds : null,
        };
      });
      parsed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setUsers(parsed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error al cargar usuarios';
      onError(msg);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      onError('El email y la contraseña son obligatorios');
      return;
    }
    const body = {
      email: email.trim(),
      password,
      quotaSeconds: parseQuota(quotaDraft),
    };
    try {
      const r = await apiFetch('/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        throw new Error(await errorMessage(r, 'No se pudo crear el usuario'));
      }
      setEmail('');
      setPassword('');
      setQuotaDraft('');
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al crear usuario';
      onError(msg);
    }
  };

  const startEdit = (u: User) => {
    setEditingId(u.id);
    setEditingValue(u.quotaSeconds === null ? '' : String(u.quotaSeconds));
  };

  const saveEdit = async (id: string) => {
    const quotaSeconds = parseQuota(editingValue);
    try {
      const r = await apiFetch(`/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quotaSeconds }),
      });
      if (!r.ok) {
        throw new Error(await errorMessage(r, 'No se pudo cambiar la cuota'));
      }
      const data: unknown = await r.json();
      const updated =
        data && typeof data === 'object' ? (data as { user?: unknown }).user : null;
      if (updated && typeof updated === 'object') {
        const item = updated as Record<string, unknown>;
        setUsers((prev) =>
          prev.map((u) =>
            u.id === id
              ? {
                  ...u,
                  quotaSeconds: typeof item.quotaSeconds === 'number' ? item.quotaSeconds : null,
                  isAdmin: Boolean(item.isAdmin),
                }
              : u,
          ),
        );
      } else {
        await load();
      }
      setEditingId(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al guardar la cuota';
      onError(msg);
    }
  };

  const remove = async (u: User) => {
    if (!confirm(`¿Eliminar la cuenta de ${u.email}? Esta acción no se puede deshacer.`)) return;
    try {
      const r = await apiFetch(`/admin/users/${u.id}`, { method: 'DELETE' });
      if (!r.ok) {
        throw new Error(await errorMessage(r, 'No se pudo eliminar el usuario'));
      }
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al eliminar usuario';
      onError(msg);
    }
  };

  return (
    <div className="users-admin-overlay">
      <div className="users-admin-panel">
        <div className="users-admin-header">
          <h2>Gestor de usuarios</h2>
          <button className="btn btn-secondary" onClick={onClose}>
            Cerrar
          </button>
        </div>

        <form className="users-admin-form" onSubmit={handleCreate}>
          <input
            type="email"
            className="users-admin-input"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            className="users-admin-input"
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <input
            type="number"
            className="users-admin-input"
            placeholder="Cuota (s) — vacío = default"
            value={quotaDraft}
            onChange={(e) => setQuotaDraft(e.target.value)}
          />
          <button type="submit" className="btn btn-primary">
            Crear usuario
          </button>
        </form>

        {loading && users.length === 0 && (
          <p className="users-admin-empty">Cargando usuarios…</p>
        )}

        <div className="users-admin-table-wrap">
          <table className="users-admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Creado</th>
                <th>Cuota</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.email}
                    {u.isAdmin && <span className="admin-badge">admin</span>}
                  </td>
                  <td>{new Date(u.createdAt).toLocaleString()}</td>
                  <td>
                    {editingId === u.id ? (
                      <input
                        type="number"
                        className="users-admin-input users-admin-input-small"
                        value={editingValue}
                        onChange={(e) => setEditingValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveEdit(u.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        autoFocus
                      />
                    ) : (
                      <span className="users-admin-quota">{formatQuota(u.quotaSeconds)}</span>
                    )}
                  </td>
                  <td>
                    {editingId === u.id ? (
                      <div className="users-admin-actions">
                        <button className="btn btn-primary" onClick={() => void saveEdit(u.id)}>
                          Guardar
                        </button>
                        <button className="btn btn-secondary" onClick={() => setEditingId(null)}>
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <div className="users-admin-actions">
                        <button className="btn btn-secondary" onClick={() => startEdit(u)}>
                          Editar
                        </button>
                        <button className="btn btn-danger" onClick={() => void remove(u)}>
                          Eliminar
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && !loading && (
                <tr>
                  <td colSpan={4} className="users-admin-empty-cell">
                    No hay usuarios
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
