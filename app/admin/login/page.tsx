export const metadata = { title: 'Admin Login — OTCIntel' };

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <div style={{
        width: 360,
        padding: '2rem',
        background: 'var(--card-bg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}>
        <h1 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1.5rem' }}>
          OTCIntel Admin
        </h1>
        {error && (
          <p style={{ color: 'var(--red)', marginBottom: '1rem', fontSize: '0.875rem' }}>
            Invalid password. Try again.
          </p>
        )}
        <form action="/api/admin/auth" method="POST">
          <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-dim)' }}>
            Admin secret
          </label>
          <input
            type="password"
            name="password"
            autoFocus
            required
            style={{
              width: '100%',
              padding: '0.5rem 0.75rem',
              background: 'var(--input-bg, var(--bg))',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--text)',
              fontSize: '0.875rem',
              boxSizing: 'border-box',
            }}
          />
          <button
            type="submit"
            style={{
              marginTop: '1rem',
              width: '100%',
              padding: '0.5rem',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
