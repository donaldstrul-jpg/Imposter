(() => {
  const socket   = io();

  if (!localStorage.getItem('imposport_token')) { window.location.replace('/'); return; }

  const gameData = JSON.parse(sessionStorage.getItem('gameData') || 'null');
  if (!gameData) { window.location.href = '/'; return; }

  const { roomId, role, category, word, hint, playerIndex, players } = gameData;
  const authUser = localStorage.getItem('imposport_user');

  // ── Role banner ───────────────────────────────────────────────────────────────
  const roleBanner  = document.getElementById('role-banner');
  const roleContent = document.getElementById('role-content');
  const toggleBtn   = document.getElementById('toggle-role-btn');
  let roleVisible = true;

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
  function proBadgeHtml(isPro) { return isPro ? ' <span class="game-pro-badge">PRO</span>' : ''; }

  const localP = players[playerIndex];
  document.getElementById('local-label').innerHTML = `${localP.name} (You)${proBadgeHtml(localP.isPro)}`;
  document.getElementById('no-cam-local-initial').textContent = localP.name.charAt(0).toUpperCase();
  if (localP.avatarUrl) {
    const img = document.createElement('img');
    img.src = localP.avatarUrl; img.className = 'no-cam-avatar';
    document.getElementById('no-cam-local').appendChild(img);
  }

  const remotePlayers = players
    .map((p, i) => ({ ...p, index: i }))
    .filter(p => p.index !== playerIndex);

  const remoteSlots = [
    {
      video: document.getElementById('remote0-video'),
      label: document.getElementById('remote0-label'),
      noCam: document.getElementById('no-cam-remote0'),
    },
    {
      video: document.getElementById('remote1-video'),
      label: document.getElementById('remote1-label'),
      noCam: document.getElementById('no-cam-remote1'),
    },
  ];

  remotePlayers.forEach((p, slotIdx) => {
    remoteSlots[slotIdx].label.innerHTML = p.name + proBadgeHtml(p.isPro);
    if (p.avatarUrl) {
      const img = document.createElement('img');
      img.src = p.avatarUrl; img.className = 'no-cam-avatar';
      remoteSlots[slotIdx].noCam.appendChild(img);
    }
  });

  // ── Voting ────────────────────────────────────────────────────────────────────
  const voteBar     = document.getElementById('vote-bar');
  const voteOptions = document.getElementById('vote-options');
  const voteStatus  = document.getElementById('vote-status');
  let hasVoted = false;

  function showVoteBar() {
    document.getElementById('waiting-overlay').style.display = 'none';
    voteBar.style.display = 'flex';
    remotePlayers.forEach(p => {
      const btn = document.createElement('button');
      btn.className   = 'btn-vote-player';
      btn.textContent = p.name;
      btn.addEventListener('click', () => {
        if (hasVoted) return;
        hasVoted = true;
        btn.classList.add('voted');
        voteOptions.querySelectorAll('.btn-vote-player').forEach(b => { b.disabled = true; });
        socket.emit('submitVote', { roomId, votedForIndex: p.index });
      });
      voteOptions.appendChild(btn);
    });
  }

  socket.on('voteProgress', ({ votesIn }) => {
    voteStatus.textContent = `${votesIn} / 3 voted`;
  });

  // ── Result overlay ────────────────────────────────────────────────────────────
  socket.on('gameResult', ({ imposterCaught, imposterIndex: impIdx, imposterName, word: secretWord, votes }) => {
    const isImposter = playerIndex === impIdx;
    const iWon       = (isImposter && !imposterCaught) || (!isImposter && imposterCaught);

    document.getElementById('result-emoji').textContent = imposterCaught ? '🚨' : '🎭';
    const verdictEl = document.getElementById('result-verdict');
    verdictEl.textContent = imposterCaught ? 'IMPOSTER CAUGHT!' : 'IMPOSTER ESCAPES!';
    verdictEl.className   = `result-verdict ${imposterCaught ? 'caught' : 'escaped'}`;

    document.getElementById('result-imposter-name').textContent = imposterName;
    document.getElementById('result-word').textContent          = secretWord;

    if (iWon && authUser) document.getElementById('result-win-badge').style.display = 'inline-block';

    const voteLines = Object.entries(votes).map(([voter, target]) =>
      `${players[voter].name} → ${players[target].name}`
    );
    document.getElementById('result-votes').textContent = `Votes: ${voteLines.join('  ·  ')}`;

    document.getElementById('result-overlay').style.display = 'flex';
  });

  // ── WebRTC ────────────────────────────────────────────────────────────────────
  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:80?transport=tcp',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
  ];

  let localStream = null;
  const pcs     = {};  // remotePlayerIndex → RTCPeerConnection
  const pending = {};  // remotePlayerIndex → ICE candidates queued before remote desc is set

  function makePc(remoteIdx) {
    if (pcs[remoteIdx]) return pcs[remoteIdx];

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcs[remoteIdx]     = pc;
    pending[remoteIdx] = [];

    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket.emit('rtc-signal', {
          roomId,
          targetIndex: remoteIdx,
          signal: { type: 'candidate', candidate: candidate.toJSON() },
        });
      }
    };

    pc.ontrack = ({ streams }) => {
      if (!streams[0]) return;
      const slot = remotePlayers.findIndex(p => p.index === remoteIdx);
      if (slot === -1) return;
      const { video, noCam } = remoteSlots[slot];
      video.srcObject = streams[0];
      video.play().catch(() => {});
      noCam.style.display = 'none';
      video.style.display = 'block';
    };

    return pc;
  }

  async function flushPending(remoteIdx) {
    const pc = pcs[remoteIdx];
    if (!pc?.remoteDescription) return;
    for (const c of (pending[remoteIdx] || [])) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    pending[remoteIdx] = [];
  }

  const TIMER_DURATION = 60000;
  const TIMER_R = 20;
  const TIMER_CIRCUMFERENCE = 2 * Math.PI * TIMER_R; // ≈ 125.66

  function showRulesOverlay(onDone) {
    document.getElementById('waiting-overlay').style.display = 'none';
    const overlay = document.getElementById('rules-overlay');
    const badge   = document.getElementById('rules-role-badge');
    badge.textContent = role === 'imposter' ? 'YOU ARE THE IMPOSTER' : 'YOU ARE A KNOWER';
    badge.className   = `rules-role-badge ${role}`;
    overlay.style.display  = 'flex';
    overlay.style.opacity  = '1';
    overlay.style.transition = 'opacity .3s ease';
    setTimeout(() => {
      overlay.style.opacity = '0';
      setTimeout(() => { overlay.style.display = 'none'; onDone(); }, 300);
    }, 3000);
  }

  function startDiscussionTimer(voteOpenAt) {
    const timerEl = document.getElementById('discussion-timer');
    const arc = document.getElementById('timer-arc');
    const numEl = document.getElementById('timer-number');

    arc.style.strokeDasharray = `${TIMER_CIRCUMFERENCE}`;
    arc.style.strokeDashoffset = '0';
    timerEl.style.display = 'flex';

    const tick = () => {
      const remaining = Math.max(0, voteOpenAt - Date.now());
      const secs = Math.ceil(remaining / 1000);
      numEl.textContent = secs;
      arc.style.strokeDashoffset = TIMER_CIRCUMFERENCE * (1 - remaining / TIMER_DURATION);
      const urgent = secs <= 5;
      arc.style.stroke = urgent ? '#e5191f' : '#ededed';
      numEl.style.color = urgent ? '#e5191f' : '#ededed';

      if (remaining <= 0) {
        timerEl.style.opacity = '0';
        setTimeout(() => { timerEl.style.display = 'none'; showVoteBar(); }, 300);
        return;
      }
      setTimeout(tick, 100);
    };

    tick();
  }

  // allPeersReady: show 3s rules overlay, then start 60s discussion timer, then reveal vote bar.
  socket.on('allPeersReady', async ({ voteOpenAt }) => {
    showRulesOverlay(() => startDiscussionTimer(voteOpenAt));

    for (const p of remotePlayers) makePc(p.index);

    for (const p of remotePlayers) {
      if (playerIndex < p.index) {
        const pc = pcs[p.index];
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('rtc-signal', {
            roomId,
            targetIndex: p.index,
            signal: { type: 'offer', sdp: pc.localDescription },
          });
        } catch (e) { console.error('offer error:', e); }
      }
    }
  });

  socket.on('rtc-signal', async ({ fromIndex, signal }) => {
    const pc = makePc(fromIndex);

    try {
      if (signal.type === 'offer') {
        if (localStream && pc.getSenders().length === 0) {
          localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        }
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        await flushPending(fromIndex);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc-signal', {
          roomId,
          targetIndex: fromIndex,
          signal: { type: 'answer', sdp: pc.localDescription },
        });
      } else if (signal.type === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          await flushPending(fromIndex);
        }
      } else if (signal.type === 'candidate' && signal.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } else {
          pending[fromIndex].push(signal.candidate);
        }
      }
    } catch (e) { console.warn('rtc-signal error:', e); }
  });

  async function init() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const lv = document.getElementById('local-video');
      lv.srcObject = localStream;
      document.getElementById('no-cam-local').style.display = 'none';
      lv.style.display = 'block';
    } catch (e) {
      console.warn('camera/mic unavailable:', e.message);
      localStream = new MediaStream();
    }

    // playerIndex lets the server update the stale lobby socket ID to this page's socket ID
    socket.emit('peerReady', { roomId, playerIndex });
  }

  init();
})();
