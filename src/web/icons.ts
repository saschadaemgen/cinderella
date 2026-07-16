/**
 * Lucide icons (A3 stack decision), inlined server-side as SVG. `lucide-static`
 * ships each icon as an SVG string; we resize via a class swap.
 */

import {
  LayoutDashboard,
  MessagesSquare,
  Users,
  Settings,
  Code,
  AlertTriangle,
  FileWarning,
  Image,
  Video,
  Mic,
  File,
  Link,
  Type,
  Trash2,
  EyeOff,
  RotateCcw,
  Activity,
} from 'lucide-static';
import { raw, type SafeHtml } from './html.js';

function sized(svg: string, cls: string): SafeHtml {
  return raw(
    svg
      .replace(/width="24"/, '')
      .replace(/height="24"/, '')
      .replace(/class="lucide ([^"]*)"/, `class="lucide $1 ${cls}"`),
  );
}

export function icon(name: keyof typeof ICONS, cls = 'h-4 w-4'): SafeHtml {
  return sized(ICONS[name], cls);
}

const ICONS = {
  dashboard: LayoutDashboard,
  messages: MessagesSquare,
  consent: Users,
  settings: Settings,
  embed: Code,
  alert: AlertTriangle,
  fileWarning: FileWarning,
  image: Image,
  video: Video,
  voice: Mic,
  file: File,
  link: Link,
  text: Type,
  delete: Trash2,
  unpublish: EyeOff,
  restore: RotateCcw,
  activity: Activity,
} as const;

/** Icon for a message type. */
export function typeIcon(type: string, cls = 'h-4 w-4'): SafeHtml {
  switch (type) {
    case 'image':
      return icon('image', cls);
    case 'video':
      return icon('video', cls);
    case 'voice':
      return icon('voice', cls);
    case 'file':
      return icon('file', cls);
    case 'link':
      return icon('link', cls);
    default:
      return icon('text', cls);
  }
}
