/**
 * Model access policies (SEC-034): which AI models may be used.
 *
 * Two layers, both checked before every model call by every agent:
 * - the people who run Talk2Tax choose the models allowed across the platform (no choice made
 *   allows every model);
 * - an organisation's owners and admins can narrow that further for their organisation (an empty
 *   list allows every model the platform allows).
 * A model a layer does not allow is never called, whether it is the organisation's own choice in
 * Settings → Integrations or the server's default.
 */
import type { PrismaService } from '../common/prisma.service';
import { AI_MODELS } from '../integrations/integrations.service';

export interface ModelAccess {
  /** Allowed across Talk2Tax, or null when no platform administrator has limited it. */
  platform: string[] | null;
  /** The organisation's own list; empty = every model the platform allows. */
  organisation: string[];
}

export const modelList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The models a platform administrator may choose from: the known Claude models and the server's default. */
export function knownModels(serverDefault: string): { id: string; name: string }[] {
  const known: { id: string; name: string }[] = AI_MODELS.map((m) => ({ id: m.id, name: m.name }));
  return known.some((m) => m.id === serverDefault) ? known : [...known, { id: serverDefault, name: `${serverDefault} (this server's default)` }];
}

export async function platformAllowedModels(prisma: PrismaService): Promise<string[] | null> {
  const last = await prisma.platformModelPolicy.findFirst({ orderBy: { createdAt: 'desc' } });
  return last && last.allowedModels !== null ? modelList(last.allowedModels) : null;
}

export async function modelAccess(prisma: PrismaService, orgId: string): Promise<ModelAccess> {
  const [platform, s] = await Promise.all([platformAllowedModels(prisma), prisma.copilotSettings.findUnique({ where: { orgId }, select: { allowedModels: true } })]);
  return { platform, organisation: modelList(s?.allowedModels) };
}

/** Why a model may not be used, or null when it may. */
export function modelRefusal(model: string, access: ModelAccess): { layer: 'PLATFORM' | 'ORGANISATION'; message: string } | null {
  if (access.platform && !access.platform.includes(model)) {
    return { layer: 'PLATFORM', message: `The AI model ${model} is not allowed on Talk2Tax by the people who run it.` };
  }
  if (access.organisation.length && !access.organisation.includes(model)) {
    return { layer: 'ORGANISATION', message: `The AI model ${model} is not allowed for this organisation.` };
  }
  return null;
}
