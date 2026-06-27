import { useEffect, useState } from 'react';
import { useRoute } from './lib/route';
import { Dashboard } from './screens/Dashboard';
import { ProjectDetail } from './screens/ProjectDetail';
import { TokenGate } from './components/TokenGate';
import { getToken, onAuthChange } from './store';

export default function App() {
  const route = useRoute();
  const [token, setTokenState] = useState<string | null>(() => getToken());

  // Re-read the token whenever it changes (set on unlock, cleared on any 401).
  useEffect(() => onAuthChange(() => setTokenState(getToken())), []);

  if (!token) return <TokenGate />;
  if (route.name === 'detail') return <ProjectDetail id={route.id} tab={route.tab} />;
  return <Dashboard />;
}
