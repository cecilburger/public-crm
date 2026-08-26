import { describe, it, expect } from 'vitest';
import { can, actorCan, canTouchConversation, ROLE_PERMISSIONS, ROLES, type Actor } from '@kirana/core';

describe('role permissions', () => {
  it('gives only the owner control of billing and deletion', () => {
    expect(can('owner', 'billing:manage')).toBe(true);
    expect(can('admin', 'billing:manage')).toBe(false);
    expect(can('owner', 'tenant:delete')).toBe(true);
    expect(can('admin', 'tenant:delete')).toBe(false);
  });

  it('keeps the audit log away from agents', () => {
    expect(can('admin', 'audit:read')).toBe(true);
    expect(can('supervisor', 'audit:read')).toBe(false);
    expect(can('agent', 'audit:read')).toBe(false);
  });

  it('lets a viewer read but never write', () => {
    expect(can('viewer', 'conversation:read')).toBe(true);
    expect(can('viewer', 'conversation:write')).toBe(false);
    expect(can('viewer', 'contact:write')).toBe(false);
    expect(can('viewer', 'deal:write')).toBe(false);
  });

  it('does not let an agent export the customer list', () => {
    expect(can('agent', 'contact:read')).toBe(true);
    expect(can('agent', 'contact:export')).toBe(false);
    expect(can('supervisor', 'contact:export')).toBe(true);
  });

  it('escalates strictly: every role is a subset of the one above it', () => {
    const order = ['viewer', 'agent', 'supervisor', 'admin', 'owner'] as const;
    for (let i = 0; i < order.length - 1; i += 1) {
      const lower = ROLE_PERMISSIONS[order[i]!];
      const higher = ROLE_PERMISSIONS[order[i + 1]!];
      for (const p of lower) expect(higher).toContain(p);
    }
  });

  it('covers every role in the matrix', () => {
    for (const role of ROLES) expect(ROLE_PERMISSIONS[role]).toBeDefined();
  });
});

describe('API key scopes narrow a role, never widen it', () => {
  const key: Actor = { userId: 'k1', tenantId: 't1', role: 'admin', scopes: ['conversation:read'] };

  it('allows only what the scope lists', () => {
    expect(actorCan(key, 'conversation:read')).toBe(true);
    expect(actorCan(key, 'conversation:write')).toBe(false);
  });

  it('cannot grant what the role lacks', () => {
    const overreaching: Actor = { userId: 'k2', tenantId: 't1', role: 'agent', scopes: ['billing:manage'] };
    expect(actorCan(overreaching, 'billing:manage')).toBe(false);
  });
});

describe('conversation ownership', () => {
  const agent: Actor = { userId: 'u-agent', tenantId: 't1', role: 'agent' };
  const supervisor: Actor = { userId: 'u-sup', tenantId: 't1', role: 'supervisor' };

  it('lets an agent reply on their own or an unclaimed conversation', () => {
    expect(canTouchConversation(agent, { assigneeId: 'u-agent' })).toBe(true);
    expect(canTouchConversation(agent, { assigneeId: null })).toBe(true);
  });

  it("stops an agent replying inside a colleague's negotiation", () => {
    expect(canTouchConversation(agent, { assigneeId: 'u-other' })).toBe(false);
  });

  it('lets a supervisor step into any conversation', () => {
    expect(canTouchConversation(supervisor, { assigneeId: 'u-other' })).toBe(true);
  });

  it('never lets a viewer write, assigned or not', () => {
    const viewer: Actor = { userId: 'u-v', tenantId: 't1', role: 'viewer' };
    expect(canTouchConversation(viewer, { assigneeId: 'u-v' })).toBe(false);
  });
});
