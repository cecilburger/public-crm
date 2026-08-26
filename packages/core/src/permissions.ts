/**
 * Role-based access control. Roles are coarse and few on purpose; anything
 * finer is expressed as a scope rule (see `canTouchConversation`) rather than
 * another role nobody can explain during an audit.
 */
export const ROLES = ['owner', 'admin', 'supervisor', 'agent', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'conversation:read', 'conversation:write', 'conversation:assign', 'conversation:close',
  'contact:read', 'contact:write', 'contact:export',
  'deal:read', 'deal:write',
  'broadcast:send', 'autopilot:manage', 'channel:manage',
  'member:manage', 'apikey:manage', 'billing:manage',
  'audit:read', 'dsr:manage', 'tenant:delete',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const AGENT: Permission[] = [
  'conversation:read', 'conversation:write', 'conversation:close',
  'contact:read', 'contact:write', 'deal:read', 'deal:write',
];

const SUPERVISOR: Permission[] = [
  ...AGENT, 'conversation:assign', 'contact:export', 'broadcast:send', 'autopilot:manage',
];

const ADMIN: Permission[] = [
  ...SUPERVISOR, 'channel:manage', 'member:manage', 'apikey:manage', 'audit:read', 'dsr:manage',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [...ADMIN, 'billing:manage', 'tenant:delete'],
  admin: ADMIN,
  supervisor: SUPERVISOR,
  agent: AGENT,
  viewer: ['conversation:read', 'contact:read', 'deal:read'],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export interface Actor {
  userId: string;
  tenantId: string;
  role: Role;
  /** API keys carry an explicit scope list that intersects with the role. */
  scopes?: readonly Permission[];
}

export function actorCan(actor: Actor, permission: Permission): boolean {
  if (!can(actor.role, permission)) return false;
  return actor.scopes ? actor.scopes.includes(permission) : true;
}

/**
 * Agents may read the whole shared inbox but only *act* on what is theirs or
 * unclaimed — stops one agent replying inside another's negotiation, which is
 * the most common real-world support incident, not a theoretical one.
 */
export function canTouchConversation(actor: Actor, conversation: { assigneeId: string | null }): boolean {
  if (!actorCan(actor, 'conversation:write')) return false;
  if (actor.role === 'agent') {
    return conversation.assigneeId === null || conversation.assigneeId === actor.userId;
  }
  return true;
}

export function assertCan(actor: Actor, permission: Permission): void {
  if (!actorCan(actor, permission)) {
    const err = new Error(`Requires ${permission}`);
    (err as Error & { code?: string }).code = 'forbidden';
    throw err;
  }
}
