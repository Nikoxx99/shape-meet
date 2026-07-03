"use client";

import { FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  BrainCircuit,
  CheckCircle2,
  CloudUpload,
  Database,
  History,
  KeyRound,
  Lock,
  LogIn,
  LogOut,
  Mail,
  PhoneOff,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  User,
  UserPlus,
  Users,
  Video,
  X,
} from "lucide-react";
import type {
  HostIdentity,
  IdentityDeliveryStatus,
  IdentityKind,
  IdentityStatus,
  Meeting,
  ShapeUser,
  UserRank,
  UserStatus,
} from "@shape-meet/shared";

type AdminSection =
  "users" | "meetings" | "identities" | "deliveries" | "audit";

type AdminMeeting = Meeting & {
  hostName: string;
  hostEmail: string;
  participantCount: number;
  createdAt: string;
  updatedAt: string;
};

type AdminIdentity = HostIdentity & {
  ownerName: string;
  ownerEmail: string;
  createdAt: string;
  updatedAt: string;
};

type AuditEntry = {
  id: string;
  action: string;
  targetId: string | null;
  actorId: string | null;
  actorName: string;
  actorEmail: string | null;
  metadata: unknown;
  createdAt: string;
};

type IdentityConfirmation =
  | { action: "revoke"; identity: AdminIdentity }
  | { action: "unpush"; identity: AdminIdentity };

const initialUserForm = {
  username: "",
  email: "",
  password: "",
  rank: "HOST" as UserRank,
};

const initialIdentityForm = {
  userId: "",
  name: "",
  kind: "PHOTO_IDENTITY" as IdentityKind,
  status: "TRAINING" as IdentityStatus,
  version: "v0",
  artifactUri: "",
  artifactSha256: "",
  artifactSizeBytes: "",
  artifactFile: null as File | null,
};

const sectionMeta: Record<
  AdminSection,
  { label: string; title: string; icon: ReactNode }
> = {
  users: { label: "Usuarios", title: "Usuarios y hosts", icon: <Users /> },
  meetings: { label: "Reuniones", title: "Reuniones", icon: <Video /> },
  identities: {
    label: "Rostros aprobados",
    title: "Rostros aprobados",
    icon: <ShieldCheck />,
  },
  deliveries: { label: "Entregas", title: "Entregas", icon: <CloudUpload /> },
  audit: { label: "Auditoría", title: "Auditoría", icon: <Shield /> },
};

const defaultAdminIdentifier =
  process.env.NODE_ENV === "development" ? "admin@shape.test" : "";

export function UsersClient() {
  const [adminUser, setAdminUser] = useState<ShapeUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginForm, setLoginForm] = useState({
    identifier: defaultAdminIdentifier,
    password: "",
  });
  const [section, setSection] = useState<AdminSection>("users");
  const [users, setUsers] = useState<ShapeUser[]>([]);
  const [meetings, setMeetings] = useState<AdminMeeting[]>([]);
  const [identities, setIdentities] = useState<AdminIdentity[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [userForm, setUserForm] = useState(initialUserForm);
  const [identityForm, setIdentityForm] = useState(initialIdentityForm);
  const [identityFileInputKey, setIdentityFileInputKey] = useState(0);
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [identityDialogOpen, setIdentityDialogOpen] = useState(false);
  const [meetingToEnd, setMeetingToEnd] = useState<AdminMeeting | null>(null);
  const [identityConfirmation, setIdentityConfirmation] =
    useState<IdentityConfirmation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void restoreAdminSession();
  }, []);

  useEffect(() => {
    const firstHost = users.find(
      (user) => user.rank === "HOST" || user.rank === "ADMIN",
    );
    if (!identityForm.userId && firstHost) {
      setIdentityForm((current) => ({ ...current, userId: firstHost.id }));
    }
  }, [identityForm.userId, users]);

  const hosts = useMemo(
    () => users.filter((user) => user.rank === "HOST" || user.rank === "ADMIN"),
    [users],
  );
  const availableIdentities = identities.filter(
    (identity) => identity.status === "AVAILABLE",
  );
  const trainingIdentities = identities.filter(
    (identity) => identity.status === "TRAINING",
  );
  const activeMeetings = meetings.filter(
    (meeting) => meeting.status === "LIVE" || meeting.status === "WAITING",
  );

  const metrics = [
    ["Usuarios", String(users.length), "totales"],
    [
      "Hosts activos",
      String(hosts.filter((user) => user.status === "ACTIVE").length),
      "con rango host",
    ],
    ["Reuniones", String(meetings.length), `${activeMeetings.length} activas`],
    [
      "Rostros",
      String(availableIdentities.length),
      `${trainingIdentities.length} entrenando`,
    ],
  ];

  async function restoreAdminSession() {
    setLoading(true);
    setMessage(null);

    try {
      const data = await getJson<{ user: ShapeUser | null }>(
        "/api/auth/host/me",
      );
      if (!data.user || data.user.rank !== "ADMIN") {
        throw new Error("Ingresa con un usuario admin.");
      }
      setAdminUser(data.user);
      await loadAdminData();
    } catch {
      setAdminUser(null);
      setLoading(false);
    } finally {
      setAuthChecked(true);
    }
  }

  async function loginAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const data = await postJson<{ session: { user: ShapeUser } }>(
        "/api/auth/host/login",
        loginForm,
      );
      if (data.session.user.rank !== "ADMIN") {
        throw new Error("Ingresa con un usuario admin.");
      }
      setAdminUser(data.session.user);
      await loadAdminData();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "No se pudo iniciar sesión.",
      );
    } finally {
      setSaving(false);
      setAuthChecked(true);
    }
  }

  async function loadAdminData() {
    setLoading(true);
    setMessage(null);

    try {
      const [usersData, meetingsData, identitiesData, auditData] =
        await Promise.all([
          getJson<{ users: ShapeUser[] }>("/api/users"),
          getJson<{ meetings: AdminMeeting[] }>("/api/admin/meetings"),
          getJson<{ identities: AdminIdentity[] }>("/api/admin/identities"),
          getJson<{ logs: AuditEntry[] }>("/api/admin/audit"),
        ]);

      setUsers(usersData.users);
      setMeetings(meetingsData.meetings);
      setIdentities(identitiesData.identities);
      setAudit(auditData.logs);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "No se pudo cargar el panel.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function reloadAudit() {
    const data = await getJson<{ logs: AuditEntry[] }>("/api/admin/audit");
    setAudit(data.logs);
  }

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const data = await postJson<{ user: ShapeUser }>("/api/users", userForm);
      setUsers((current) => [data.user, ...current]);
      setUserForm(initialUserForm);
      setUserDialogOpen(false);
      setMessage("Usuario creado.");
      await reloadAudit();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "No se pudo crear el usuario.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function changeRank(user: ShapeUser, nextRank: UserRank) {
    if (user.rank === nextRank) return;

    try {
      setMessage(null);
      const data = await patchJson<{ user: ShapeUser }>(
        `/api/users/${user.id}/role`,
        { rank: nextRank },
      );
      setUsers((current) =>
        current.map((item) => (item.id === data.user.id ? data.user : item)),
      );
      setMessage(
        nextRank === "HOST"
          ? "Usuario promovido a host."
          : "Usuario degradado.",
      );
      await reloadAudit();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "No se pudo actualizar el rango.",
      );
    }
  }

  async function changeUserStatus(user: ShapeUser, nextStatus: UserStatus) {
    if (user.status === nextStatus) return;

    try {
      setMessage(null);
      const data = await patchJson<{ user: ShapeUser }>(
        `/api/users/${user.id}/status`,
        { status: nextStatus },
      );
      setUsers((current) =>
        current.map((item) => (item.id === data.user.id ? data.user : item)),
      );
      setMessage(
        nextStatus === "ACTIVE" ? "Usuario activado." : "Usuario desactivado.",
      );
      await reloadAudit();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "No se pudo actualizar el estado.",
      );
    }
  }

  async function logoutAdmin() {
    try {
      await postJson<{ ok: boolean }>("/api/auth/host/logout");
    } finally {
      setAdminUser(null);
      setUsers([]);
      setMeetings([]);
      setIdentities([]);
      setAudit([]);
      setMessage(null);
      setLoginForm((current) => ({ ...current, password: "" }));
    }
  }

  async function createIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.set("userId", identityForm.userId);
      formData.set("name", identityForm.name);
      formData.set("kind", identityForm.kind);
      formData.set("status", identityForm.status);
      formData.set("version", identityForm.version);
      if (identityForm.artifactUri.trim())
        formData.set("artifactUri", identityForm.artifactUri.trim());
      if (identityForm.artifactSha256.trim())
        formData.set("artifactSha256", identityForm.artifactSha256.trim());
      if (identityForm.artifactSizeBytes.trim())
        formData.set(
          "artifactSizeBytes",
          identityForm.artifactSizeBytes.trim(),
        );
      if (identityForm.artifactFile)
        formData.set("artifactFile", identityForm.artifactFile);

      const data = await postForm<{ identity: AdminIdentity }>(
        "/api/admin/identities",
        formData,
      );
      setIdentities((current) => [data.identity, ...current]);
      setIdentityForm({ ...initialIdentityForm, userId: identityForm.userId });
      setIdentityFileInputKey((current) => current + 1);
      setIdentityDialogOpen(false);
      setMessage("Rostro agregado.");
      await reloadAudit();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "No se pudo crear el rostro.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function changeIdentityStatus(
    identity: AdminIdentity,
    status: IdentityStatus,
  ) {
    if (identity.status === status) return true;

    setSaving(true);
    setMessage(null);

    try {
      const data = await patchJson<{ identity: AdminIdentity }>(
        `/api/admin/identities/${identity.id}/status`,
        { status },
      );
      setIdentities((current) =>
        current.map((item) =>
          item.id === data.identity.id ? data.identity : item,
        ),
      );
      setMessage(
        status === "REVOKED" ? "Rostro revocado." : "Estado actualizado.",
      );
      await reloadAudit();
      return true;
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "No se pudo actualizar el estado del rostro.",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function changeIdentityDelivery(
    identity: AdminIdentity,
    action: "push" | "unpush",
  ) {
    setSaving(true);
    setMessage(null);

    try {
      const data = await patchJson<{ identity: AdminIdentity }>(
        `/api/admin/identities/${identity.id}/delivery`,
        { action },
      );
      setIdentities((current) =>
        current.map((item) =>
          item.id === data.identity.id ? data.identity : item,
        ),
      );
      setMessage(
        action === "push"
          ? "Rostro publicado para el host."
          : "Publicación retirada.",
      );
      await reloadAudit();
      return true;
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "No se pudo actualizar la entrega del rostro.",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  function requestIdentityStatusChange(
    identity: AdminIdentity,
    status: IdentityStatus,
  ) {
    if (status === "REVOKED" && identity.status !== "REVOKED") {
      setIdentityConfirmation({ action: "revoke", identity });
      return;
    }

    void changeIdentityStatus(identity, status);
  }

  function requestIdentityDeliveryChange(
    identity: AdminIdentity,
    action: "push" | "unpush",
  ) {
    if (action === "unpush") {
      setIdentityConfirmation({ action: "unpush", identity });
      return;
    }

    void changeIdentityDelivery(identity, action);
  }

  async function confirmIdentityAction() {
    if (!identityConfirmation) return;

    const succeeded =
      identityConfirmation.action === "revoke"
        ? await changeIdentityStatus(identityConfirmation.identity, "REVOKED")
        : await changeIdentityDelivery(identityConfirmation.identity, "unpush");

    if (succeeded) setIdentityConfirmation(null);
  }

  async function endAdminMeeting(meeting: AdminMeeting) {
    if (meeting.status === "ENDED") return;

    setSaving(true);
    setMessage(null);

    try {
      const data = await postJson<{ meeting: Meeting }>(
        `/api/meetings/${encodeURIComponent(meeting.code)}/end`,
      );
      setMeetings((current) =>
        current.map((item) =>
          item.id === data.meeting.id ? mergeAdminMeeting(item, data.meeting) : item,
        ),
      );
      setMeetingToEnd(null);
      setMessage(
        meeting.status === "SCHEDULED"
          ? "Reunión cancelada."
          : "Reunión finalizada.",
      );
      await reloadAudit();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "No se pudo finalizar la reunión.",
      );
    } finally {
      setSaving(false);
    }
  }

  const title = sectionMeta[section].title;

  if (!authChecked) {
    return <AdminLoadingScreen />;
  }

  if (!adminUser) {
    return (
      <AdminLoginScreen
        form={loginForm}
        message={message}
        saving={saving}
        onChange={setLoginForm}
        onSubmit={loginAdmin}
      />
    );
  }

  return (
    <main className="admin-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">
            <Video />
          </span>
          <div>
            <strong>Shape Meet</strong>
            <span>Administración</span>
          </div>
        </div>
        <nav>
          {(Object.keys(sectionMeta) as AdminSection[]).map((item) => (
            <button
              className={section === item ? "active" : ""}
              key={item}
              type="button"
              onClick={() => setSection(item)}
            >
              {sectionMeta[item].icon}
              {sectionMeta[item].label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span>{adminUser.email}</span>
          <button type="button" onClick={() => void logoutAdmin()}>
            <LogOut /> Salir
          </button>
        </div>
      </aside>

      <section className="admin-content">
        <header className="admin-header">
          <h1>{title}</h1>
          <div className="admin-actions">
            <button
              className="secondary-button"
              onClick={() => void loadAdminData()}
              type="button"
            >
              <RefreshCw /> Actualizar
            </button>
            {section === "users" ? (
              <button
                className="primary-button"
                onClick={() => setUserDialogOpen(true)}
                type="button"
              >
                <Plus /> Crear usuario
              </button>
            ) : null}
            {section === "identities" ? (
              <button
                className="primary-button"
                onClick={() => setIdentityDialogOpen(true)}
                type="button"
              >
                <Plus /> Agregar rostro
              </button>
            ) : null}
          </div>
        </header>

        <section className="metrics-grid">
          {metrics.map(([label, value, hint]) => (
            <article className="metric-card" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
              <small>{hint}</small>
            </article>
          ))}
        </section>

        {message ? (
          <div className="admin-notice">
            <CheckCircle2 />
            <span>{message}</span>
          </div>
        ) : null}

        {section === "users" && (
          <UsersSection
            loading={loading}
            users={users}
            onRankChange={changeRank}
            onStatusChange={changeUserStatus}
          />
        )}
        {section === "meetings" && (
          <MeetingsSection
            loading={loading}
            meetings={meetings}
            onEndMeeting={setMeetingToEnd}
          />
        )}
        {section === "identities" && (
          <IdentitiesSection
            loading={loading}
            identities={identities}
            onStatusChange={requestIdentityStatusChange}
            onDeliveryChange={requestIdentityDeliveryChange}
          />
        )}
        {section === "deliveries" && (
          <DeliveriesSection
            identities={identities}
            onDeliveryChange={requestIdentityDeliveryChange}
          />
        )}
        {section === "audit" && (
          <AuditSection loading={loading} audit={audit} />
        )}
      </section>

      <Modal
        open={userDialogOpen}
        title="Crear usuario"
        onClose={() => setUserDialogOpen(false)}
      >
        <UserForm
          form={userForm}
          saving={saving}
          onChange={setUserForm}
          onSubmit={createUser}
        />
      </Modal>

      <Modal
        open={identityDialogOpen}
        title="Agregar rostro"
        onClose={() => setIdentityDialogOpen(false)}
      >
        <IdentityForm
          form={identityForm}
          hosts={hosts}
          saving={saving}
          fileInputKey={identityFileInputKey}
          onChange={setIdentityForm}
          onSubmit={createIdentity}
        />
      </Modal>

      <Modal
        open={Boolean(meetingToEnd)}
        title={meetingToEnd?.status === "SCHEDULED" ? "Cancelar reunión" : "Finalizar reunión"}
        onClose={() => setMeetingToEnd(null)}
      >
        {meetingToEnd ? (
          <div className="confirmation-body">
            <div className="confirmation-icon">
              <PhoneOff />
            </div>
            <div>
              <h2>{meetingToEnd.title}</h2>
              <p>
                {formatDate(meetingToEnd.startsAt)} · {meetingToEnd.code}
              </p>
            </div>
            <div className="confirmation-actions">
              <button
                className="secondary-button"
                disabled={saving}
                type="button"
                onClick={() => setMeetingToEnd(null)}
              >
                Mantener
              </button>
              <button
                className="danger-button"
                disabled={saving}
                type="button"
                onClick={() => void endAdminMeeting(meetingToEnd)}
              >
                <PhoneOff />
                {saving
                  ? "Procesando"
                  : meetingToEnd.status === "SCHEDULED"
                    ? "Cancelar reunión"
                    : "Finalizar reunión"}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(identityConfirmation)}
        title={
          identityConfirmation?.action === "revoke"
            ? "Revocar rostro"
            : "Retirar publicación"
        }
        onClose={() => setIdentityConfirmation(null)}
      >
        {identityConfirmation ? (
          <div className="confirmation-body">
            <div className="confirmation-icon">
              {identityConfirmation.action === "revoke" ? (
                <Shield />
              ) : (
                <CloudUpload />
              )}
            </div>
            <div>
              <h2>{identityConfirmation.identity.name}</h2>
              <p>
                {identityConfirmation.identity.ownerName} ·{" "}
                {identityConfirmation.identity.version}
              </p>
            </div>
            <div className="confirmation-actions">
              <button
                className="secondary-button"
                disabled={saving}
                type="button"
                onClick={() => setIdentityConfirmation(null)}
              >
                Mantener
              </button>
              <button
                className="danger-button"
                disabled={saving}
                type="button"
                onClick={() => void confirmIdentityAction()}
              >
                {identityConfirmation.action === "revoke" ? (
                  <Shield />
                ) : (
                  <CloudUpload />
                )}
                {saving
                  ? "Procesando"
                  : identityConfirmation.action === "revoke"
                    ? "Revocar rostro"
                    : "Retirar publicación"}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </main>
  );
}

function AdminLoadingScreen() {
  return (
    <main className="admin-login-shell">
      <section className="admin-login-card">
        <span className="login-mark">
          <Video />
        </span>
        <h1>Shape Meet</h1>
        <p>Cargando panel</p>
      </section>
    </main>
  );
}

function AdminLoginScreen({
  form,
  message,
  saving,
  onChange,
  onSubmit,
}: {
  form: { identifier: string; password: string };
  message: string | null;
  saving: boolean;
  onChange: (form: { identifier: string; password: string }) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <main className="admin-login-shell">
      <form className="admin-login-card" onSubmit={onSubmit}>
        <span className="login-mark">
          <Lock />
        </span>
        <h1>Shape Meet Admin</h1>
        <Field label="Correo o usuario" icon={<Mail />}>
          <input
            required
            autoComplete="username"
            value={form.identifier}
            onChange={(event) =>
              onChange({ ...form, identifier: event.target.value })
            }
          />
        </Field>
        <Field label="Clave" icon={<KeyRound />}>
          <input
            required
            autoComplete="current-password"
            minLength={8}
            type="password"
            value={form.password}
            onChange={(event) =>
              onChange({ ...form, password: event.target.value })
            }
          />
        </Field>
        {message ? (
          <div className="admin-notice">
            <Shield />
            <span>{message}</span>
          </div>
        ) : null}
        <button className="primary-button full" disabled={saving}>
          <LogIn /> {saving ? "Validando" : "Entrar"}
        </button>
      </form>
    </main>
  );
}

function Modal({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;

  const titleId = `modal-${title.toLowerCase().replace(/\W+/g, "-")}`;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="modal-panel"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button
            aria-label="Cerrar"
            className="icon-button"
            type="button"
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function UserForm({
  form,
  saving,
  onChange,
  onSubmit,
}: {
  form: typeof initialUserForm;
  saving: boolean;
  onChange: (form: typeof initialUserForm) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="modal-form" onSubmit={onSubmit}>
      <Field label="Usuario" icon={<UserPlus />}>
        <input
          required
          minLength={3}
          value={form.username}
          onChange={(event) =>
            onChange({ ...form, username: event.target.value })
          }
        />
      </Field>
      <Field label="Correo" icon={<Mail />}>
        <input
          required
          type="email"
          value={form.email}
          onChange={(event) => onChange({ ...form, email: event.target.value })}
        />
      </Field>
      <Field label="Clave" icon={<KeyRound />}>
        <input
          required
          minLength={8}
          type="password"
          value={form.password}
          onChange={(event) =>
            onChange({ ...form, password: event.target.value })
          }
        />
      </Field>
      <Field label="Rango" icon={<ShieldCheck />}>
        <select
          value={form.rank}
          onChange={(event) =>
            onChange({ ...form, rank: event.target.value as UserRank })
          }
        >
          <option value="HOST">Host</option>
          <option value="USER">Usuario</option>
        </select>
      </Field>
      <button className="primary-button full" disabled={saving}>
        <Plus /> {saving ? "Creando" : "Crear usuario"}
      </button>
    </form>
  );
}

function IdentityForm({
  form,
  hosts,
  saving,
  fileInputKey,
  onChange,
  onSubmit,
}: {
  form: typeof initialIdentityForm;
  hosts: ShapeUser[];
  saving: boolean;
  fileInputKey: number;
  onChange: (form: typeof initialIdentityForm) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="modal-form" onSubmit={onSubmit}>
      <Field label="Host" icon={<User />}>
        <select
          required
          value={form.userId}
          onChange={(event) =>
            onChange({ ...form, userId: event.target.value })
          }
        >
          <option disabled value="">
            Seleccionar host
          </option>
          {hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.username} · {host.email}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Nombre" icon={<ShieldCheck />}>
        <input
          required
          value={form.name}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
        />
      </Field>
      <div className="modal-form-grid">
        <Field label="Tipo" icon={<BrainCircuit />}>
          <select
            value={form.kind}
            onChange={(event) =>
              onChange({ ...form, kind: event.target.value as IdentityKind })
            }
          >
            <option value="PHOTO_IDENTITY">Foto</option>
            <option value="TRAINED_IDENTITY">Entrenado</option>
            <option value="OPEN_MODEL_IDENTITY">Modelo</option>
          </select>
        </Field>
        <Field label="Estado" icon={<CheckCircle2 />}>
          <select
            value={form.status}
            onChange={(event) =>
              onChange({
                ...form,
                status: event.target.value as IdentityStatus,
              })
            }
          >
            <option value="TRAINING">Entrenando</option>
            <option value="AVAILABLE">Disponible</option>
            <option value="REVOKED">Revocado</option>
          </select>
        </Field>
      </div>
      <Field label="Versión" icon={<Database />}>
        <input
          required
          value={form.version}
          onChange={(event) =>
            onChange({ ...form, version: event.target.value })
          }
        />
      </Field>
      <Field label="Archivo" icon={<CloudUpload />}>
        <input
          key={fileInputKey}
          type="file"
          onChange={(event) =>
            onChange({ ...form, artifactFile: event.target.files?.[0] ?? null })
          }
        />
      </Field>
      {form.artifactFile ? (
        <div className="file-summary">
          <strong>{form.artifactFile.name}</strong>
          <span>{formatBytes(form.artifactFile.size)}</span>
        </div>
      ) : null}
      <Field label="URI del artefacto" icon={<CloudUpload />}>
        <input
          disabled={Boolean(form.artifactFile)}
          value={form.artifactUri}
          onChange={(event) =>
            onChange({ ...form, artifactUri: event.target.value })
          }
        />
      </Field>
      <div className="modal-form-grid">
        <Field label="SHA256" icon={<KeyRound />}>
          <input
            value={form.artifactSha256}
            onChange={(event) =>
              onChange({ ...form, artifactSha256: event.target.value })
            }
          />
        </Field>
        <Field label="Tamaño" icon={<Database />}>
          <input
            disabled={Boolean(form.artifactFile)}
            inputMode="numeric"
            min="0"
            type="number"
            value={form.artifactSizeBytes}
            onChange={(event) =>
              onChange({ ...form, artifactSizeBytes: event.target.value })
            }
          />
        </Field>
      </div>
      <button
        className="primary-button full"
        disabled={saving || hosts.length === 0}
      >
        <Plus /> {saving ? "Agregando" : "Agregar rostro"}
      </button>
    </form>
  );
}

function UsersSection({
  loading,
  users,
  onRankChange,
  onStatusChange,
}: {
  loading: boolean;
  users: ShapeUser[];
  onRankChange: (user: ShapeUser, rank: UserRank) => void;
  onStatusChange: (user: ShapeUser, status: UserStatus) => void;
}) {
  return (
    <section className="table-card full-width">
      <div className="table-row users-table table-head">
        <span>Usuario</span>
        <span>Correo</span>
        <span>Rango</span>
        <span>Estado</span>
        <span>Último acceso</span>
        <span>Acción</span>
      </div>
      {loading ? (
        <div className="empty-row">Cargando usuarios</div>
      ) : users.length === 0 ? (
        <div className="empty-row">No hay usuarios creados</div>
      ) : (
        users.map((user) => (
          <div className="table-row users-table" key={user.id}>
            <strong>{user.username}</strong>
            <span>{user.email}</span>
            <Rank rank={user.rank} />
            <Status status={user.status} />
            <span>{user.lastAccess}</span>
            <div className="table-actions">
              {user.rank === "ADMIN" ? (
                <span className="muted-action">Admin</span>
              ) : (
                <>
                  <select
                    className="rank-select"
                    value={user.rank}
                    onChange={(event) =>
                      onRankChange(user, event.target.value as UserRank)
                    }
                  >
                    <option value="USER">Usuario</option>
                    <option value="HOST">Host</option>
                  </select>
                  <button
                    className={`mini-button ${user.status === "ACTIVE" ? "" : "primary"}`}
                    type="button"
                    onClick={() =>
                      onStatusChange(
                        user,
                        user.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
                      )
                    }
                  >
                    {user.status === "ACTIVE" ? "Desactivar" : "Activar"}
                  </button>
                </>
              )}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function MeetingsSection({
  loading,
  meetings,
  onEndMeeting,
}: {
  loading: boolean;
  meetings: AdminMeeting[];
  onEndMeeting: (meeting: AdminMeeting) => void;
}) {
  return (
    <section className="table-card full-width">
      <div className="table-row meetings-table table-head">
        <span>Reunión</span>
        <span>Host</span>
        <span>Fecha</span>
        <span>Acceso</span>
        <span>Estado</span>
        <span>Participantes</span>
        <span>Código</span>
        <span>Acción</span>
      </div>
      {loading ? (
        <div className="empty-row">Cargando reuniones</div>
      ) : meetings.length === 0 ? (
        <div className="empty-row">No hay reuniones creadas</div>
      ) : (
        meetings.map((meeting) => (
          <div className="table-row meetings-table" key={meeting.id}>
            <strong>{meeting.title}</strong>
            <span>{meeting.hostName}</span>
            <span>{formatDate(meeting.startsAt)}</span>
            <span>
              {meeting.access === "INVITE_ONLY"
                ? inviteSummary(meeting.invitedEmails)
                : "Público"}
            </span>
            <StatusChip
              label={meetingStatusLabel(meeting.status)}
              tone={meeting.status === "LIVE" ? "ok" : "idle"}
            />
            <span>
              {meeting.participantCount}/{meeting.maxParticipants}
            </span>
            <span>{meeting.code}</span>
            <div className="table-actions">
              {meeting.status === "ENDED" ? (
                <span className="muted-action">Cerrada</span>
              ) : (
                <button
                  className="mini-button danger"
                  type="button"
                  onClick={() => onEndMeeting(meeting)}
                >
                  {meeting.status === "SCHEDULED" ? "Cancelar" : "Finalizar"}
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function mergeAdminMeeting(
  current: AdminMeeting,
  meeting: Meeting,
): AdminMeeting {
  return {
    ...current,
    ...meeting,
    participantCount: meeting.participants.filter(
      (participant) => !participant.leftAt,
    ).length,
  };
}

function IdentitiesSection({
  loading,
  identities,
  onStatusChange,
  onDeliveryChange,
}: {
  loading: boolean;
  identities: AdminIdentity[];
  onStatusChange: (identity: AdminIdentity, status: IdentityStatus) => void;
  onDeliveryChange: (
    identity: AdminIdentity,
    action: "push" | "unpush",
  ) => void;
}) {
  return (
    <section className="table-card full-width">
      <div className="table-row identities-table table-head">
        <span>Rostro</span>
        <span>Host</span>
        <span>Tipo</span>
        <span>Estado</span>
        <span>Entrega</span>
        <span>Versión</span>
        <span>Acción</span>
      </div>
      {loading ? (
        <div className="empty-row">Cargando rostros</div>
      ) : identities.length === 0 ? (
        <div className="empty-row">No hay rostros aprobados</div>
      ) : (
        identities.map((identity) => (
          <div className="table-row identities-table" key={identity.id}>
            <strong title={artifactIntegrityLabel(identity)}>{identity.name}</strong>
            <span>{identity.ownerName}</span>
            <span>{identityKindLabel(identity.kind)}</span>
            <StatusChip
              label={identityStatusLabel(identity.status)}
              tone={
                identity.status === "AVAILABLE"
                  ? "ok"
                  : identity.status === "TRAINING"
                    ? "warning"
                    : "idle"
              }
            />
            <StatusChip
              label={deliveryStatusLabel(identity.deliveryStatus ?? "PENDING")}
              tone={deliveryStatusTone(identity.deliveryStatus ?? "PENDING")}
            />
            <span>{identity.version}</span>
            <div className="table-actions">
              <select
                className="rank-select"
                value={identity.status}
                onChange={(event) =>
                  onStatusChange(identity, event.target.value as IdentityStatus)
                }
              >
                <option value="TRAINING">Entrenando</option>
                <option value="AVAILABLE">Disponible</option>
                <option value="REVOKED">Revocado</option>
              </select>
              {identity.deliveryStatus === "PUSHED" ? (
                <button
                  className="mini-button"
                  type="button"
                  onClick={() => onDeliveryChange(identity, "unpush")}
                >
                  Retirar
                </button>
              ) : (
                <button
                  className="mini-button primary"
                  type="button"
                  disabled={
                    identity.status !== "AVAILABLE" ||
                    !hasPublishableArtifact(identity)
                  }
                  title={artifactIntegrityLabel(identity)}
                  onClick={() => onDeliveryChange(identity, "push")}
                >
                  Push
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function DeliveriesSection({
  identities,
  onDeliveryChange,
}: {
  identities: AdminIdentity[];
  onDeliveryChange: (
    identity: AdminIdentity,
    action: "push" | "unpush",
  ) => void;
}) {
  const deliveries = identities.map((identity) => ({
    identity,
    artifact: identity.artifactUri ?? "Pendiente",
    status: identity.status,
    deliveryStatus: identity.deliveryStatus ?? "PENDING",
  }));

  return (
    <section className="delivery-grid">
      {deliveries.length === 0 ? (
        <div className="empty-row standalone">
          No hay entregas de modelos todavía
        </div>
      ) : (
        deliveries.map((delivery) => (
          <article className="delivery-card" key={delivery.identity.id}>
            <div className="delivery-icon">
              <CloudUpload />
            </div>
            <div>
              <h2>{delivery.identity.name}</h2>
              <p>{delivery.identity.ownerName}</p>
            </div>
            <div className="delivery-statuses">
              <StatusChip
                label={identityStatusLabel(delivery.status)}
                tone={
                  delivery.status === "AVAILABLE"
                    ? "ok"
                    : delivery.status === "TRAINING"
                      ? "warning"
                      : "idle"
                }
              />
              <StatusChip
                label={deliveryStatusLabel(delivery.deliveryStatus)}
                tone={deliveryStatusTone(delivery.deliveryStatus)}
              />
            </div>
            <span>{delivery.artifact}</span>
            {delivery.identity.artifactSha256 ? (
              <small>
                sha256: {delivery.identity.artifactSha256.slice(0, 16)}
              </small>
            ) : null}
            {delivery.identity.publishedAt ? (
              <small>
                Publicado {formatDate(delivery.identity.publishedAt)}
              </small>
            ) : null}
            {delivery.deliveryStatus === "PUSHED" ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => onDeliveryChange(delivery.identity, "unpush")}
              >
                Retirar publicación
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                disabled={
                  delivery.identity.status !== "AVAILABLE" ||
                  !hasPublishableArtifact(delivery.identity)
                }
                title={artifactIntegrityLabel(delivery.identity)}
                onClick={() => onDeliveryChange(delivery.identity, "push")}
              >
                Publicar para host
              </button>
            )}
          </article>
        ))
      )}
    </section>
  );
}

function AuditSection({
  loading,
  audit,
}: {
  loading: boolean;
  audit: AuditEntry[];
}) {
  return (
    <section className="table-card full-width">
      <div className="table-row audit-table table-head">
        <span>Evento</span>
        <span>Actor</span>
        <span>Destino</span>
        <span>Fecha</span>
        <span>Detalle</span>
      </div>
      {loading ? (
        <div className="empty-row">Cargando auditoría</div>
      ) : audit.length === 0 ? (
        <div className="empty-row">No hay eventos registrados</div>
      ) : (
        audit.map((entry) => (
          <div className="table-row audit-table" key={entry.id}>
            <strong>{auditActionLabel(entry.action)}</strong>
            <span>{entry.actorName}</span>
            <span>{entry.targetId ?? "N/A"}</span>
            <span>{formatDate(entry.createdAt)}</span>
            <span>{metadataPreview(entry.metadata)}</span>
          </div>
        ))
      )}
    </section>
  );
}

function Rank({ rank }: { rank: UserRank }) {
  return (
    <span className={`rank ${rank.toLowerCase()}`}>{rankLabel(rank)}</span>
  );
}

function Status({ status }: { status: string }) {
  const label =
    status === "ACTIVE"
      ? "Activo"
      : status === "PENDING"
        ? "Pendiente"
        : "Inactivo";
  return <span className={`status ${status.toLowerCase()}`}>{label}</span>;
}

function StatusChip({
  label,
  tone = "idle",
}: {
  label: string;
  tone?: "ok" | "warning" | "idle";
}) {
  return <span className={`status-chip ${tone}`}>{label}</span>;
}

function Field({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div>
        {icon}
        {children}
      </div>
    </label>
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
  });
  return readJsonResponse<T>(response);
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readJsonResponse<T>(response);
}

async function postForm<T>(path: string, body: FormData): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    body,
  });
  return readJsonResponse<T>(response);
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonResponse<T>(response);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    requestId?: string;
    detail?: {
      name?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
  };
  if (!response.ok) {
    const pieces = [data.error ?? "La API no respondió correctamente."];
    if (data.code) pieces.push(`Código: ${data.code}`);
    if (data.detail?.message) pieces.push(data.detail.message);
    if (
      data.detail?.cause?.message &&
      data.detail.cause.message !== data.detail.message
    )
      pieces.push(data.detail.cause.message);
    if (data.requestId) pieces.push(`ID: ${data.requestId}`);
    throw new Error(pieces.join(" · "));
  }
  return data as T;
}

function rankLabel(rank: UserRank) {
  if (rank === "USER") return "Usuario";
  if (rank === "HOST") return "Host";
  return "Admin";
}

function identityKindLabel(kind: IdentityKind) {
  if (kind === "PHOTO_IDENTITY") return "Foto";
  if (kind === "TRAINED_IDENTITY") return "Entrenado";
  if (kind === "OPEN_MODEL_IDENTITY") return "Modelo";
  return "Modelo";
}

function identityStatusLabel(status: IdentityStatus) {
  if (status === "AVAILABLE") return "Disponible";
  if (status === "TRAINING") return "Entrenando";
  return "Revocado";
}

function deliveryStatusLabel(status: IdentityDeliveryStatus) {
  if (status === "PUSHED") return "Publicado";
  if (status === "READY") return "Listo";
  if (status === "REVOKED") return "Retirado";
  return "Pendiente";
}

function deliveryStatusTone(
  status: IdentityDeliveryStatus,
): "ok" | "warning" | "idle" {
  if (status === "PUSHED") return "ok";
  if (status === "READY") return "warning";
  return "idle";
}

function hasPublishableArtifact(identity: Pick<HostIdentity, "artifactUri" | "artifactSha256" | "artifactSizeBytes">) {
  return Boolean(
    identity.artifactUri?.trim() &&
      identity.artifactSha256?.trim().match(/^[a-f0-9]{64}$/i) &&
      identity.artifactSizeBytes &&
      identity.artifactSizeBytes > 0,
  );
}

function artifactIntegrityLabel(identity: Pick<HostIdentity, "artifactUri" | "artifactSha256" | "artifactSizeBytes">) {
  if (hasPublishableArtifact(identity)) return "Artefacto listo para publicar";
  if (!identity.artifactUri) return "Falta artefacto";
  if (!identity.artifactSha256?.trim().match(/^[a-f0-9]{64}$/i)) return "Falta SHA256 válido";
  return "Falta tamaño del artefacto";
}

function inviteSummary(invitedEmails: string[]) {
  if (invitedEmails.length === 0) return "Sin correos";
  if (invitedEmails.length === 1) return "1 invitado";
  return `${invitedEmails.length} invitados`;
}

function meetingStatusLabel(status: Meeting["status"]) {
  if (status === "SCHEDULED") return "Agendada";
  if (status === "WAITING") return "Espera";
  if (status === "LIVE") return "En vivo";
  return "Finalizada";
}

function auditActionLabel(action: string) {
  return action
    .split("_")
    .map((part) => part.slice(0, 1) + part.slice(1).toLowerCase())
    .join(" ");
}

function metadataPreview(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return "";
  const entries = Object.entries(metadata as Record<string, unknown>).slice(
    0,
    2,
  );
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ");
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(new Date(value));
}
