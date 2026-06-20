(() => {
  const socket   = io();
  const gameData = JSON.parse(sessionStorage.getItem('gameData') || 'null');
  const myPeerId = sessionStorage.getItem('peerId');

  if (!gameData || !myPeerId) {
    window.location.href = '/';
    return;
  }

  const { roomId, role, category, word, hint, playerIndex, players } = gameData;

  // ── Role banner ──────────────────────────────────────────────────────────────
  const roleBanner  = document.getElementById('role-banner');
  const roleContent = document.getElementById('role-content');
  const toggleBtn   = document.getElementById('toggle-role-btn');
  let roleVisible   = true;

  if (role === 'imposter') {
    roleBanner.classList.add('imposter');
    roleContent.innerHTML = `
      <div class="role-row">
        <div>
          <div class="role-label">Category</div>
          <div class="role-title imposter-text">${category}</div>
        </div>
        <div class="role-divider"></div>
        <div>
          <div class="role-label">Your role</div>
          <div class="role-title imposter-text">IMPOSTER</div>
        </div>
        <div class="role-divider"></div>
        <div class="hint-block">
          <div class="role-label">Hint</div>
          <div class="role-title imposter-hint">${hint}</div>
        </div>
      </div>
    `;
  } else {
    roleBanner.classList.add('knower');
    roleContent.innerHTML = `
      <div class="role-row">
        <div>
          <div class="role-label">Category</div>
          <div class="role-title knower-text">${category}</div>
        </div>
        <div class="role-divider"></div>
        <div>
          <div class="role-label">The player is</div>
          <div class="role-title knower-text">${word}</div>
          <div class="role-hint">Find the imposter who doesn't know!</div>
        </div>
      </div>
    `;
  }

  toggleBtn.addEventListener('click', () => {
    roleVisible = !roleVisible;
    roleContent.style.filter  = roleVisible ? 'none' : 'blur(12px) brightness(0.3)';
    toggleBtn.textContent     = roleVisible ? '👁 Hide' : '👁 Show';
  });

  // ── Player labels ─────────────────────────────────────────────────────────────
  document.getElementById('local-label').textContent =
    `${players[playerIndex].name} (You)`;

  // Initial avatar for no-cam placeholder
  const initial = players[playerIndex].name.charAt(0).toUpperCase();
  document.getElementById('no-cam-local-initial').textContent = initial;

  // Remote players (everyone except me), preserving their original index
  const remotePlayers = players
    .map((p, i) => ({ ...p, index: i }))
    .filter((p) => p.index !== playerIndex);

  const remoteSlots = [
    {
      video:       document.getElementById('remote0-video'),
      label:       document.getElementById('remote0-label'),
      noCam:       document.getElementById('no-cam-remote0'),
    },
    {
      video:       document.getElementById('remote1-video'),
      label:       document.getElementById('remote1-label'),
      noCam:       document.getElementById('no-cam-remote1'),
    },
  ];

  remotePlayers.forEach((p, slotIdx) => {
    remoteSlots[slotIdx].label.textContent = p.name;
    // Replace spinner with initial once we know the name
    remoteSlots[slotIdx].noCam.classList.remove('connecting');
    remoteSlots[slotIdx].noCam.innerHTML =
      `<span>${p.name.charAt(0).toUpperCase()}</span>`;
  });

  // peerId → slot index (0 or 1)
  const peerToSlot = {};
  remotePlayers.forEach((p, slotIdx) => {
    peerToSlot[p.peerId] = slotIdx;
  });

  // ── WebRTC via PeerJS ─────────────────────────────────────────────────────────
  let localStream = null;

  const peer = new Peer(myPeerId, {
    host:  window.location.hostname,
    port:  Number(window.location.port) || (window.location.protocol === 'https:' ? 443 : 80),
    path:  '/peerjs',
    debug: 1,
  });

  function attachStream(slotIdx, stream) {
    const { video, noCam } = remoteSlots[slotIdx];
    video.srcObject = stream;
    video.play().catch(() => {});
    // Hide the avatar placeholder once the video stream arrives
    noCam.style.display = 'none';
    video.style.display = 'block';
  }

  async function init() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const localVideo = document.getElementById('local-video');
      localVideo.srcObject = localStream;
      document.getElementById('no-cam-local').style.display = 'none';
      localVideo.style.display = 'block';
    } catch (err) {
      console.warn('Could not access camera/mic:', err.message);
      // Fall back to a silent empty stream so PeerJS calls still work
      localStream = new MediaStream();
    }

    peer.on('open', () => {
      socket.emit('peerReady', { roomId });
    });

    // Answer incoming calls from higher-indexed peers
    peer.on('call', (call) => {
      call.answer(localStream);
      call.on('stream', (remoteStream) => {
        const slot = peerToSlot[call.peer];
        if (slot !== undefined) attachStream(slot, remoteStream);
      });
      call.on('error', (err) => console.error('Incoming call error:', err));
    });

    peer.on('error', (err) => console.error('Peer error:', err));

    // Server tells us all 3 PeerJS peers are open — now safe to call
    socket.on('allPeersReady', () => {
      // Lower-indexed player calls higher-indexed ones to avoid duplicates
      remotePlayers.forEach((p) => {
        if (playerIndex < p.index) {
          const call = peer.call(p.peerId, localStream);
          if (!call) return;
          call.on('stream', (remoteStream) => {
            const slot = peerToSlot[p.peerId];
            if (slot !== undefined) attachStream(slot, remoteStream);
          });
          call.on('error', (err) => console.error('Outgoing call error:', err));
        }
      });

      // Dismiss the connecting overlay after a generous grace period
      setTimeout(() => {
        document.getElementById('waiting-overlay').style.display = 'none';
      }, 3500);
    });
  }

  init();
})();
