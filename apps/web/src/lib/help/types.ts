/** Help for a page or a section: what it is for, how to use it, and where it fits. */
export interface Help {
  what: string;
  how: string;
  /** Pages always say where they fit; a section may leave it to its page. */
  where?: string;
}
