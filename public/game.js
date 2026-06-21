(() => {
  const socket   = io();
  const gameData = JSON.parse(sessionStorage.getItem('gameData') || 'null');

  if (!gameData) { window.location.href = '/'; return; }

  const { roomId, role, category, word, hint, playerIndex, players, jitsiRoom } = gameData;
  const authUser = localStorage.getItem('imposter_user');

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

  // ── Voting ────────────────────────────────────────────────────────────────────
  const voteBar     = document.getElementById('vote-bar');
  const voteOptions = document.getElementById('vote-options');
  const voteStatus  = document.getElementById('vote-status');
  let hasVoted = false;

  const remotePlayers = players.map((p, i) => ({ ...p, index: i })).filter(p => p.index !== playerIndex);

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
  socket.on('gameResult', ({ imposterCaught, imposterIndex: impIdx, imposterName, word: secretWord, topVote, votes }) => {
    const isImposter = playerIndex === impIdx;
    const iWon       = isImposter && !imposterCaught;

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

  // ── Video call (framatalk.org — no moderator/JWT requirement) ─────────────────
  socket.on('allPeersReady', () => {
    showVoteBar();
  });

  function init() {
    let peerReadySent = false;
    function sendPeerReady() {
      if (peerReadySent) return;
      peerReadySent = true;
      socket.emit('peerReady', { roomId, playerIndex });
    }

    const peerReadyTimeout = setTimeout(sendPeerReady, 20000);

    const api = new JitsiMeetExternalAPI('framatalk.org', {
      roomName:   jitsiRoom,
      width:      '100%',
      height:     '100%',
      parentNode: document.getElementById('video-container'),
      userInfo:   { displayName: players[playerIndex].name },
      configOverwrite: {
        prejoinPageEnabled:  false,
        startWithAudioMuted: false,
        startWithVideoMuted: false,
        disableDeepLinking:  true,
        enableWelcomePage:   false,
      },
      interfaceConfigOverwrite: {
        SHOW_JITSI_WATERMARK:      false,
        SHOW_WATERMARK_FOR_GUESTS: false,
        SHOW_BRAND_WATERMARK:      false,
        SHOW_POWERED_BY:           false,
        TOOLBAR_BUTTONS: ['microphone', 'camera', 'tileview', 'fullscreen'],
      },
    });

    api.addEventListener('videoConferenceJoined', () => {
      clearTimeout(peerReadyTimeout);
      sendPeerReady();
    });

    api.addEventListener('errorOccurred', () => {
      clearTimeout(peerReadyTimeout);
      sendPeerReady();
    });
  }

  init();
})();
