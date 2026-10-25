import { useEffect, useRef, useState } from 'react';

export type Profile = { id: string; name: string; username: string; email: string; active: boolean; expiresAt: string | null; patInvalid: boolean };
export type ProfileInput = { name: string; username: string; email: string; pat: string };

function ProfileForm({ profile, close, saved }: { profile: Profile | null; close: () => void; saved: (profiles: Profile[]) => void }) {
  const [input, setInput] = useState<ProfileInput>({ name: profile?.name ?? '', username: profile?.username ?? '', email: profile?.email ?? '', pat: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const complete = input.name.trim() && input.username.trim() && input.email.trim() && (profile || input.pat.trim());
  const changed = !profile || input.name !== profile.name || input.username !== profile.username || input.email !== profile.email || Boolean(input.pat.trim());
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="profile-form-title" onCancel={event => { event.preventDefault(); if (!submitting.current) close(); }}><header><h1 id="profile-form-title">{profile ? 'Edit Profile' : 'Create Profile'}</h1><button disabled={busy} aria-label="Close profile form" onClick={close}>×</button></header><form onSubmit={async event => {
    event.preventDefault(); if (!complete || !changed || submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try { saved(profile ? await window.gitforge.editProfile(profile.id, input) : await window.gitforge.createProfile(input)); }
    catch (error) { setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not save the profile. Please try again.'); setBusy(false); submitting.current = false; }
  }}>
    {([['name', 'Profile name'], ['username', 'GitHub username'], ['email', 'Email'], ['pat', 'GitHub PAT']] as const).map(([key, label]) => <label key={key}>{label}<input autoFocus={key === 'name'} type={key === 'pat' ? 'password' : 'text'} autoComplete="off" disabled={busy} value={input[key]} onChange={event => setInput(previous => ({ ...previous, [key]: event.target.value }))}/></label>)}
    {profile && <p className="muted small">Leave the PAT blank to keep the existing token.</p>}
    {error && <p role="alert" className="create-error">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" disabled={!complete || !changed || busy}>{busy ? 'Verifying with GitHub...' : profile ? 'Save Changes' : 'Create Profile'}</button></footer>
  </form></dialog>;
}

function DeleteProfile({ profile, close, deleted }: { profile: Profile; close: () => void; deleted: (profiles: Profile[]) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="delete-profile-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}><header><h1 id="delete-profile-title">Delete Profile</h1></header><div className="delete-profile-body"><p>Delete profile “{profile.name}”? Its saved credentials will be removed.</p>{error && <p role="alert">{error}</p>}<footer><button disabled={busy} onClick={close}>Cancel</button><button disabled={busy} onClick={async () => { if (busy) return; setBusy(true); try { deleted(await window.gitforge.deleteProfile(profile.id)); } catch { setError('Could not delete the profile.'); setBusy(false); } }}>Confirm</button></footer></div></dialog>;
}

export function ProfilesPage({ profiles, updated }: { profiles: Profile[]; updated: (profiles: Profile[]) => void }) {
  const [form, setForm] = useState<{ profile: Profile | null } | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { const close = () => setMenu(null); const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); }; window.addEventListener('click', close); window.addEventListener('keydown', key); return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', key); }; }, []);
  return <><div className="profiles-heading"><h1>Profiles</h1><button onClick={() => setForm({ profile: null })}>Create Profile</button></div>
    {!profiles.length && <p>Create a profile to use GitForge.</p>}
    {error && <p role="alert">{error}</p>}
    <table className="profiles-table"><thead><tr><th>Profile Name <span aria-hidden="true">&#9652;</span></th><th>Author Name</th><th>Author Email</th><th><span className="visually-hidden">Actions</span></th></tr></thead><tbody>{profiles.map(profile => <tr key={profile.id} className={profile.active ? 'active-profile' : ''}><td className="profile-identity">{profile.active && <span className="profile-check" aria-label="Active profile">&#10003;</span>}<span className="profile-avatar" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3Z"/></svg></span><span className="profile-name">{profile.name}</span></td><td>{profile.username}</td><td>{profile.email}</td><td className="profile-actions"><button aria-label={`Actions for ${profile.name}`} aria-expanded={menu === profile.id} onClick={event => { event.stopPropagation(); setMenu(previous => previous === profile.id ? null : profile.id); }}>&#8942;</button>{menu === profile.id && <div className="profile-menu" role="menu"><button role="menuitem" disabled={profile.active} onClick={async () => { try { updated(await window.gitforge.switchProfile(profile.id)); } catch { setError('Could not switch profiles.'); } }}>Switch to this profile</button><button role="menuitem" onClick={() => setForm({ profile })}>Edit</button><button role="menuitem" onClick={() => setDeleting(profile)}>Delete</button></div>}</td></tr>)}</tbody></table>
    {form && <ProfileForm profile={form.profile} close={() => setForm(null)} saved={values => { updated(values); setForm(null); }}/ >}
    {deleting && <DeleteProfile profile={deleting} close={() => setDeleting(null)} deleted={values => { updated(values); setDeleting(null); }}/ >}
  </>;
}
