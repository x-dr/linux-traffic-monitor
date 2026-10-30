import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setCsrf } from './api';
import type { NodeView, Overview } from '@traffic/contracts';

export type Session = { username: string; csrf: string };
const Context = createContext<{ session: Session | null | undefined; pending: boolean }>({ session: null, pending: true });
export function SessionProvider({ children }: { children: ReactNode }) {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ['session'], queryFn: () => api<Session>('/auth/session'), retry: false, staleTime: Infinity });
  const session = query.data;
  useEffect(() => {
    setCsrf(session?.csrf || '');
    const expire = () => { setCsrf(''); cache.setQueryData(['session'], null); cache.removeQueries({ predicate: q => q.queryKey[0] !== 'session' }); };
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, [session, cache]);
  useEffect(() => {
    if (!session) return;
    const source = new EventSource('/api/v1/events');
    let lastHistory = 0;
    source.addEventListener('snapshot', event => {
      const value = JSON.parse((event as MessageEvent).data) as { nodes: NodeView[]; overview: Overview };
      cache.setQueryData(['nodes'], { nodes: value.nodes });
      cache.setQueryData(['overview'], value.overview);
      for (const node of value.nodes) cache.setQueryData(['node', node.id], node);
      cache.setQueryData(['connection'], true);
      if (Date.now() - lastHistory > 15000) { void cache.invalidateQueries({ queryKey: ['history'] }); lastHistory = Date.now(); }
    });
    source.onerror = () => { cache.setQueryData(['connection'], false); void cache.invalidateQueries({ queryKey: ['session'] }); };
    return () => source.close();
  }, [session, cache]);
  return <Context.Provider value={{ session: query.isError ? null : session, pending: query.isPending }}>{children}</Context.Provider>;
}
export const useSession = () => useContext(Context);
