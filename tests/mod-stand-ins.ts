// Stand-ins for the UI elements the mod builds, shared by the tests that load mods/hcoord/main.js.

/** A stand-in element: any builder call chains; children, ids, clicks, key handlers and tooltips are kept for the test to read. */
export function el(...args: any[]) {
  const node: any = { args, kids: [] as any[], elementId: null, click: null, keyDown: null, tip: null };
  const self: any = new Proxy(node, {
    get(n, k) {
      if (k in n) return n[k];
      if (k === "child") return (c: any) => (n.kids.push(c), self);
      if (k === "children") return (cs: any[]) => (n.kids.push(...cs), self);
      if (k === "when") return (c: any, f: (e: any) => any) => (c ? f(self) : self);
      if (k === "id") return (id: string) => ((n.elementId = id), self);
      if (k === "on_click") return (f: any) => ((n.click = f), self);
      if (k === "on_key_down") return (f: any) => ((n.keyDown = f), self);
      if (k === "tooltip") return (tip: string) => ((n.tip = tip), self);
      return () => self;
    },
  });
  return self;
}
export const walk = (e: any): any[] => (e?.kids ? [e, ...e.kids.flatMap(walk)] : [e]);
export const textOf = (e: any) => walk(e).filter((x) => typeof x === "string").join(" ");
export const byId = (e: any, id: string) => walk(e).find((x) => x?.elementId === id);
