// Install, offline and notification controls for the SMKO PWA. Notification permission is always requested
// only from the player's explicit button press (never on page load).
type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type PwaOptions = { toast: (text: string, ms?: number) => void };

export function setupPwa({ toast }: PwaOptions) {
  const install = document.getElementById('btn-install') as HTMLButtonElement;
  const notifications = document.getElementById('btn-notifications') as HTMLButtonElement;
  let deferred: InstallPrompt | null = null;
  let registration: ServiceWorkerRegistration | null = null;

  const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const updateInstall = () => { install.hidden = standalone() || !deferred; };

  addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPrompt;
    updateInstall();
  });
  addEventListener('appinstalled', () => { deferred = null; updateInstall(); toast('SMKO instalado neste dispositivo.'); });

  install.addEventListener('click', async () => {
    if (!deferred) { toast('Use o menu do navegador para instalar o SMKO.'); return; }
    await deferred.prompt();
    const choice = await deferred.userChoice;
    deferred = null;
    updateInstall();
    if (choice.outcome === 'accepted') toast('Instalação iniciada.');
  });

  const updateNotifications = () => {
    if (!('Notification' in window)) { notifications.hidden = true; return; }
    notifications.hidden = false;
    notifications.textContent = Notification.permission === 'granted' ? '🔔 notificações' : '🔔 avisos';
    notifications.title = Notification.permission === 'granted' ? 'Notificações ativas' : 'Ativar avisos do SMKO';
  };
  updateNotifications();
  notifications.addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    updateNotifications();
    if (permission !== 'granted') { toast('Os avisos não foram autorizados. Você pode mudar isso nas configurações do navegador.'); return; }
    registration ??= await navigator.serviceWorker?.ready ?? null;
    if (registration) await registration.showNotification('SMKO pronto!', {
      body: 'Você receberá os avisos importantes do jogo neste dispositivo.',
      icon: '/icons/smko-192.png', badge: '/icons/smko-192.png', tag: 'smko-ready',
    });
    toast('Notificações ativadas.');
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((reg) => {
        registration = reg;
        if (reg.waiting) toast('Uma atualização do SMKO está pronta. Reabra o app para aplicá-la.', 5000);
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) toast('Atualização baixada. Reabra o app quando puder.', 5000);
          });
        });
      })
      .catch(() => { /* PWA is optional; the game keeps working online. */ });
  }

  addEventListener('online', () => toast('Conexão restaurada.'));
  addEventListener('offline', () => toast('Sem conexão: o app permanece disponível, mas partidas online exigem internet.', 6000));
}
