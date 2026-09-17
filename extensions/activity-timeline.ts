export type ActivityMemberKind = "tool" | "thinking";

export type ActivityMember = {
  id: string;
  kind: ActivityMemberKind;
  toolCallId?: string;
  toolName?: string;
  messageKey?: string;
  thinking?: string;
};

export type ActivityGroup = {
  id: string;
  members: ActivityMember[];
  toolCallIds: string[];
  thoughtCount: number;
};

const toolMemberId = (toolCallId: string) => `tool:${toolCallId}`;
const thinkingMemberId = (messageKey: string) => `thinking:${messageKey}`;

/**
 * Transcript-first activity grouping. The timeline owns chronology and hard
 * boundaries; renderers only project its groups into Pi components.
 */
export class ActivityTimeline {
  private groupsById = new Map<string, ActivityGroup>();
  private memberGroups = new Map<string, string>();
  private toolMembers = new Map<string, string>();
  private thinkingMembers = new Map<string, string>();
  private currentGroupId?: string;
  private sequence = 0;

  clear(): void {
    this.groupsById.clear();
    this.memberGroups.clear();
    this.toolMembers.clear();
    this.thinkingMembers.clear();
    this.currentGroupId = undefined;
    this.sequence = 0;
  }

  boundary(): void {
    this.currentGroupId = undefined;
  }

  private currentGroup(): ActivityGroup {
    if (this.currentGroupId) {
      const current = this.groupsById.get(this.currentGroupId);
      if (current) return current;
    }
    const id = `activity:${++this.sequence}`;
    const group: ActivityGroup = { id, members: [], toolCallIds: [], thoughtCount: 0 };
    this.groupsById.set(id, group);
    this.currentGroupId = id;
    return group;
  }

  addTool(toolCallId: string, toolName: string): ActivityMember {
    const existingId = this.toolMembers.get(toolCallId);
    if (existingId) return this.member(existingId)!;
    const member: ActivityMember = {
      id: toolMemberId(toolCallId),
      kind: "tool",
      toolCallId,
      toolName,
    };
    const group = this.currentGroup();
    group.members.push(member);
    group.toolCallIds.push(toolCallId);
    this.memberGroups.set(member.id, group.id);
    this.toolMembers.set(toolCallId, member.id);
    return member;
  }

  addThinking(messageKey: string, thinking: string): ActivityMember | undefined {
    const normalized = thinking.trim();
    if (!normalized) return undefined;
    const existingId = this.thinkingMembers.get(messageKey);
    if (existingId) {
      const existing = this.member(existingId);
      if (existing) existing.thinking = normalized;
      return existing;
    }
    const member: ActivityMember = {
      id: thinkingMemberId(messageKey),
      kind: "thinking",
      messageKey,
      thinking: normalized,
    };
    const group = this.currentGroup();
    group.members.push(member);
    group.thoughtCount += 1;
    this.memberGroups.set(member.id, group.id);
    this.thinkingMembers.set(messageKey, member.id);
    return member;
  }

  groups(): ActivityGroup[] {
    return [...this.groupsById.values()];
  }

  group(groupId: string): ActivityGroup | undefined {
    return this.groupsById.get(groupId);
  }

  member(memberId: string): ActivityMember | undefined {
    const groupId = this.memberGroups.get(memberId);
    return groupId ? this.groupsById.get(groupId)?.members.find((member) => member.id === memberId) : undefined;
  }

  groupForMember(memberId: string): ActivityGroup | undefined {
    const groupId = this.memberGroups.get(memberId);
    return groupId ? this.groupsById.get(groupId) : undefined;
  }

  memberForTool(toolCallId: string): ActivityMember | undefined {
    const memberId = this.toolMembers.get(toolCallId);
    return memberId ? this.member(memberId) : undefined;
  }

  memberForThinking(messageKey: string): ActivityMember | undefined {
    const memberId = this.thinkingMembers.get(messageKey);
    return memberId ? this.member(memberId) : undefined;
  }

  groupForTool(toolCallId: string): ActivityGroup | undefined {
    const member = this.memberForTool(toolCallId);
    return member ? this.groupForMember(member.id) : undefined;
  }

  groupForThinking(messageKey: string): ActivityGroup | undefined {
    const member = this.memberForThinking(messageKey);
    return member ? this.groupForMember(member.id) : undefined;
  }
}

export const assistantMessageKey = (message: any): string => {
  const timestamp = message?.timestamp;
  if (typeof timestamp === "number" || typeof timestamp === "string") return String(timestamp);
  const firstToolCall = Array.isArray(message?.content)
    ? message.content.find((item: any) => item?.type === "toolCall" && item.id)?.id
    : undefined;
  return firstToolCall ? `tool-message:${firstToolCall}` : `message:${JSON.stringify(message?.content ?? "")}`;
};

export const thinkingText = (message: any): string => {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((item: any) => item?.type === "thinking" && typeof item.thinking === "string")
    .map((item: any) => item.thinking.trim())
    .filter(Boolean)
    .join("\n\n");
};

export const visibleAssistantText = (message: any): boolean =>
  typeof message?.content === "string"
    ? message.content.trim().length > 0
    : Array.isArray(message?.content) && message.content.some(
      (item: any) => item?.type === "text" && typeof item.text === "string" && item.text.trim().length > 0,
    );

export const assistantSystemBoundary = (message: any): boolean =>
  message?.role === "assistant" && ["error", "aborted", "length"].includes(message?.stopReason);
