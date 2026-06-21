(() => {
  const socket   = io();
  const gameData = JSON.parse(sessionStorage.getItem('gameData') || 'null');
  const myPeerId = sessionStorage.getItem('peerId');

  if (!gameData || !myPeerId) { window.location.href = '/'; return; }

  const { roomId, role, category, word, hint, playerIndex, players } = gameData;
  const authToken  = localStorage.getItem('imposter_token');
  const authUser   = localStorage.getItem('imposter_user');

  // ── Role banner ───────────────────────────────────────────────────────────────
  const roleBanner  = document.getElementById('role-banner');
  const roleContent = document.getElementById('role-content');
  const toggleBtn   = document.getElementById('toggle-role-btn');
  let roleVisible   = true;

  if (role === 'imposter') {
    roleBanner.classList.add('imposter');
    roleContent.innerHTML = `
      <div class="role-row">
        <div><div class="role-label">Category</div><div class="role-title imposter-text">${category}</div></div>
        <div class="role-divider"></div>
        <div><div class="role-label">Your role</div><div class="role-title imposter-text">IMPOSTER</div></div>
        <div class="role-divider"></div>
        <div class="hint-block"><div class="role-label">Hint</div><div class="role-title imposter-hint">${hint}</div></div>
      </div>`;
  } else {
    roleBanner.classList.add('knower');
    roleContent.innerHTML = `
      <div class="role-row">
        <div><div class="role-label">Category</div><div class="role-title knower-text">${category}</div></div>
        <div class="role-divider"></div>
        <div><div class="role-label">The player is</div><div class="role-title knower-text">${word}</div><div class="role-hint">Find the imposter who doesn't know!</div></div>
      </div>`;
  }

  toggleBtn.addEventListener('click', () => {
    roleVisible = !roleVisible;
    roleContent.style.filter = roleVisible ? 'none' : 'blur(12px) brightness(0.3)';
    toggleBtn.textContent    = roleVisible ? '👁 Hide' : '👁 Show';
  });

  // ── Player labels ─────────────────────────────────────────────────────────────
  document.getElementById('local-label').textContent = `${players[playerIndex].name} (You)`;
  document.getElementById('no-cam-local-initial').textContent = players[playerIndex].name.charAt(0).toUpperCase();

  const remotePlayers = players.map((p, i) => ({ ...p, index: i })).filter((p) => p.index !== playerIndex);

  const remoteSlots = [
    { video: document.getElementById('remote0-video'), label: document.getElementById('remote0-label'), noCam: document.getElementById('no-cam-remote0') },
    { video: document.getElementById('remote1-video'), label: document.getElementById('remote1-label'), noCam: document.getElementById('no-cam-remote1') },
  ];

  remotePlayers.forEach((p, slotIdx) => {
    remoteSlots[slotIdx].label.textContent = p.name;
    remoteSlots[slotIdx].noCam.classList.remove('connecting');
    remoteSlots[slotIdx].noCam.innerHTML = `<span>${p.name.charAt(0).toUpperCase()}</span>`;
  });

  const peerToSlot = {};
  remotePlayers.forEach((p, slotIdx) => { peerToSlot[p.peerId] = slotIdx; });

  // ── Voting ────────────────────────────────────────────────────────────────────
  const voteBar     = document.getElementById('vote-bar');
  const voteOptions = document.getElementById('vote-options');
  const voteStatus  = document.getElementById('vote-status');
  let   hasVoted    = false;

  function showVoteBar() {
    voteBar.style.display = 'flex';
    remotePlayers.forEach((p) => {
      const btn = document.createElement('button');
      btn.className   = 'btn-vote-player';
      btn.textContent = p.name;
      btn.addEventListener('click', () => {
        if (hasVoted) return;
        hasVoted = true;
        btn.classList.add('voted');
        voteOptions.querySelectorAll('.btn-vote-player').forEach((b) => { b.disabled = true; });
        socket.emit('submitVote', { roomId, votedForIndex: p.index });
      });
      voteOptions.appendChild(btn);
    });
  }

  socket.on('voteProgress', ({ votesIn }) => {
    voteStatus.textContent = `${votesIn} / 3 voted`;
  });

  // ── Result overlay ────────────────────────────────────────────────────────────
  socket.on('gameResult', ({ imposterCaught, imposterIndex: impIdx, imposterName, word: secretWord, topVote, votes }) => {
    const isImposter  = playerIndex === impIdx;
    const iWon        = isImposter && !imposterCaught;

    document.getElementById('result-emoji').textContent     = imposterCaught ? '🚨' : '🎭';
    const verdictEl = document.getElementById('result-verdict');
    verdictEl.textContent = imposterCaught ? 'IMPOSTER CAUGHT!' : 'IMPOSTER ESCAPES!';
    verdictEl.className   = `result-verdict ${imposterCaught ? 'caught' : 'escaped'}`;

    document.getElementById('result-imposter-name').textContent = imposterName;
    document.getElementById('result-word').textContent          = secretWord;

    if (iWon && authUser) {
      document.getElementById('result-win-badge').style.display = 'inline-block';
    }

    // Vote breakdown
    const voteLines = Object.entries(votes).map(([voter, target]) => {
      const voterName  = players[voter].name;
      const targetName = players[target].name;
      return `${voterName} → ${targetName}`;
    });
    document.getElementById('result-votes').textContent = `Votes: ${voteLines.join('  ·  ')}`;

    document.getElementById('result-overlay').style.display = 'flex';
  });

  // ── WebRTC via PeerJS ─────────────────────────────────────────────────────────
  let localStream = null;

  const isSecure = window.location.protocol === 'https:';
  const peer = new Peer(myPeerId, {
    host:   window.location.hostname,
    port:   Number(window.location.port) || (isSecure ? 443 : 80),
    path:   '/peerjs',
    secure: isSecure,
    debug:  1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ],
    },
  });

  function attachStream(slotIdx, stream) {
    const { video, noCam } = remoteSlots[slotIdx];
    video.srcObject    = stream;
    video.play().catch(() => {});
    noCam.style.display  = 'none';
    video.style.display  = 'block';
  }

  async function init() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const lv = document.getElementById('local-video');
      lv.srcObject = localStream;
      document.getElementById('no-cam-local').style.display = 'none';
      lv.style.display = 'block';
    } catch (err) {
      console.warn('Could not access camera/mic:', err.message);
      localStream = new MediaStream();
    }

    peer.on('open', () => { socket.emit('peerReady', { roomId }); });

    peer.on('call', (call) => {
      call.answer(localStream);
      call.on('stream', (remoteStream) => {
        const slot = peerToSlot[call.peer];
        if (slot !== undefined) attachStream(slot, remoteStream);
      });
      call.on('error', (err) => console.error('Incoming call error:', err));
    });

    peer.on('error', (err) => console.error('Peer error:', err));

    socket.on('allPeersReady', () => {
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

      setTimeout(() => {
        document.getElementById('waiting-overlay').style.display = 'none';
        showVoteBar();
      }, 3500);
    });
  }

  init();
})();
