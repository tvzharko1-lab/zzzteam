import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/+esm";

const video = document.getElementById("webcam");
const canvas = document.getElementById("output_canvas");
const ctx = canvas.getContext("2d");
const statusDiv = document.getElementById("status");
const alertBox = document.getElementById("alert-box");
const alertText = document.getElementById("alert-text");
const headerDot = document.getElementById("header-dot");
const mainCard = document.getElementById("main-video-card");
const gestureBadge = document.getElementById("gesture-badge");
const countSlouchEl = document.getElementById("count-slouch");
const countYawnEl = document.getElementById("count-yawn");
const countCalibEl = document.getElementById("count-calib");
const postureStatus = document.getElementById("posture-status");
const postureBar = document.getElementById("bar-posture");
const blinkCountEl = document.getElementById("blink-count");
const calibrateBtn = document.getElementById("calibrate-btn");
const pipBtn = document.getElementById("pip-btn");
const tabBtns = document.querySelectorAll(".tab-btn");

// Элементы модального окна "i"
const infoBtns = document.querySelectorAll(".info-btn");
const infoModal = document.getElementById("info-modal");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalClose = document.getElementById("modal-close");

let faceLandmarker;
let lastVideoTime = -1;

// Базовые значения калибровки
let baselineY = null;
let baselineDist = null;

// Логи событий с временными метками
let slouchLogs = [];
let yawnLogs = [];
let calibLogs = [];
let activeTimeframe = "10m";
let isSlouchActive = false;
let isYawnActive = false;
let isTiltActive = false;
let distanceState = "ok"; // 'ok' | 'close' | 'far'
let isClosed = false;
let blinkTimestamps = [];
let pipWindow = null;

// Описания для кнопок "i"
const infoTexts = {
  slouch: {
    title: "⚠️ Сутулость",
    text: "Фиксирует отклонение спины от нормы, заданной при калибровке. Длительная сутулость создает избыточную нагрузку на шейные позвонки и поясницу, снижает объем легких и ухудшает кровоснабжение мозга."
  },
  yawn: {
    title: "🥱 Зевки",
    text: "Определяет признаки усталости и гипоксии (нехватки кислорода) по открытию рта. Частые зевки сигнализируют о необходимости сделать перерыв и проветрить комнату."
  },
  blink: {
    title: "👁️ Частота моргания",
    text: "Считает количество морганий в минуту для контроля напряжения глаз. За экраном ПК частота падает, что приводит к «синдрому сухого глаза». В норме нужно моргать 15-20 раз в минуту."
  },
  calib: {
    title: "🔄 Калибровки",
    text: "Показывает количество сбросов и обновления базовой позы. Используйте кнопку «Зафиксировать позу», если вы изменили положение тела или высоту стула."
  }
};

// Открытие модалки "i"
infoBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.info;
    if (infoTexts[type]) {
      modalTitle.innerText = infoTexts[type].title;
      modalBody.innerText = infoTexts[type].text;
      infoModal.classList.remove("hidden");
    }
  });
});

modalClose.addEventListener("click", () => infoModal.classList.add("hidden"));
infoModal.addEventListener("click", (e) => {
  if (e.target === infoModal) infoModal.classList.add("hidden");
});

// Звуковые оповещения
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let lastSoundTime = 0;

function playWarningSound() {
  const now = Date.now();
  if (now - lastSoundTime < 3000) return;
  lastSoundTime = now;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(520, audioCtx.currentTime);
  gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.35);
}

function getDistance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function getEAR(eyeLandmarks) {
  const v1 = getDistance(eyeLandmarks[1], eyeLandmarks[5]);
  const v2 = getDistance(eyeLandmarks[2], eyeLandmarks[4]);
  const h = getDistance(eyeLandmarks[0], eyeLandmarks[3]);
  return (v1 + v2) / (2.0 * h);
}

function updateCountersDisplay() {
  const now = Date.now();
  let timeWindowMs = 10 * 60 * 1000;

  if (activeTimeframe === "30m") timeWindowMs = 30 * 60 * 1000;
  if (activeTimeframe === "1h")  timeWindowMs = 60 * 60 * 1000;

  const cutoff = now - timeWindowMs;

  const filteredSlouch = slouchLogs.filter((t) => t >= cutoff).length;
  const filteredYawn = yawnLogs.filter((t) => t >= cutoff).length;
  const filteredCalib = calibLogs.filter((t) => t >= cutoff).length;

  countSlouchEl.innerText = filteredSlouch;
  countYawnEl.innerText = filteredYawn;
  countCalibEl.innerText = filteredCalib;
}

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTimeframe = btn.dataset.time;
    updateCountersDisplay();
  });
});

// Безопасная HUD-отрисовка скелета лица
function drawFaceSkeleton(landmarks, color = "#38bdf8") {
  const w = canvas.width;
  const h = canvas.height;

  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  const keyPoints = [1, 33, 133, 362, 263, 61, 291, 13, 14, 152, 234, 454];

  ctx.globalAlpha = 0.85;
  keyPoints.forEach((idx) => {
    const p = landmarks[idx];
    if (p) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 2.2, 0, 2 * Math.PI);
      ctx.fill();
    }
  });

  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.35;

  const eyeLeft = [33, 160, 158, 133, 153, 144, 33];
  const eyeRight = [362, 385, 387, 263, 373, 380, 362];
  const lips = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61];

  function drawPath(indices) {
    ctx.beginPath();
    indices.forEach((idx, i) => {
      const p = landmarks[idx];
      if (p) {
        if (i === 0) {
          ctx.moveTo(p.x * w, p.y * h);
        } else {
          ctx.lineTo(p.x * w, p.y * h);
        }
      }
    });
    ctx.stroke();
  }

  drawPath(eyeLeft);
  drawPath(eyeRight);
  drawPath(lips);

  let minX = w, maxX = 0, minY = h, maxY = 0;
  landmarks.forEach((p) => {
    const px = p.x * w;
    const py = p.y * h;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  });

  const pad = 16;
  const boxX = minX - pad;
  const boxY = minY - pad;
  const boxW = (maxX - minX) + pad * 2;
  const boxH = (maxY - minY) + pad * 2;
  const cornerLen = 14;

  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.moveTo(boxX, boxY + cornerLen);
  ctx.lineTo(boxX, boxY);
  ctx.lineTo(boxX + cornerLen, boxY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(boxX + boxW - cornerLen, boxY);
  ctx.lineTo(boxX + boxW);
  ctx.lineTo(boxX + boxW, boxY + cornerLen);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(boxX, boxY + boxH - cornerLen);
  ctx.lineTo(boxX, boxY + boxH);
  ctx.lineTo(boxX + cornerLen, boxY + boxH);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(boxX + boxW - cornerLen, boxY + boxH);
  ctx.lineTo(boxX + boxW);
  ctx.lineTo(boxX + boxW, boxY + boxH - cornerLen);
  ctx.stroke();

  ctx.restore();
}

async function init() {
  try {
    statusDiv.innerText = "Камера...";
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    await video.play();

    statusDiv.innerText = "Загрузка AI...";
    const filesetResolver = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );

    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numFaces: 1
    });

    statusDiv.innerText = "🟢 AI Активен";
    predictWebcam();
  } catch (err) {
    statusDiv.innerText = "❌ Ошибка";
    alertText.innerText = "⚠️ Не удалось запустить камеру или AI-модель.";
    console.error("Ошибка инициализации:", err);
  }
}

function performCalibration(lm) {
  baselineY = lm[1].y;
  baselineDist = getDistance(lm[234], lm[454]);
  calibLogs.push(Date.now());
  updateCountersDisplay();

  alertBox.className = "card alert-card";
  alertText.innerText = "✅ Поза зафиксирована!";
  headerDot.className = "status-dot green";
}

calibrateBtn.addEventListener("click", () => {
  if (lastLandmarks) performCalibration(lastLandmarks);
});

let lastLandmarks = null;

function predictWebcam() {
  if (canvas.width !== video.videoWidth) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  let startTimeMs = performance.now();
  if (lastVideoTime !== video.currentTime) {
    lastVideoTime = video.currentTime;

    if (faceLandmarker) {
      const results = faceLandmarker.detectForVideo(video, startTimeMs);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        const lm = results.faceLandmarks[0];
        lastLandmarks = lm;

        let activeColor = "#38bdf8";

        // Проверка дистанции
        const faceWidth = getDistance(lm[234], lm[454]);
        if (faceWidth > 0.38) {
          distanceState = "close";
        } else if (faceWidth < 0.16) {
          distanceState = "far";
        } else {
          distanceState = "ok";
        }

        // Зевок
        const topLip = lm[13];
        const bottomLip = lm[14];
        const mouthDistance = getDistance(topLip, bottomLip);

        if (mouthDistance > 0.08) {
          if (!isYawnActive) {
            isYawnActive = true;
            yawnLogs.push(Date.now());
            updateCountersDisplay();
          }
          activeColor = "#f59e0b";
          mainCard.className = "card video-card state-yawn";
          if (gestureBadge) gestureBadge.innerText = "🥱 Зевок / Усталость";
          headerDot.className = "status-dot yellow";
        } else {
          isYawnActive = false;
        }

        // Наклон головы
        const leftEar = lm[234];
        const rightEar = lm[454];
        const earTilt = Math.abs(leftEar.y - rightEar.y);

        if (earTilt > 0.09) {
          if (!isTiltActive) {
            isTiltActive = true;
            performCalibration(lm);
          }
          activeColor = "#3b82f6";
          mainCard.className = "card video-card state-calib";
          if (gestureBadge) gestureBadge.innerText = "🔄 Калибровка";
          headerDot.className = "status-dot blue";
        } else {
          isTiltActive = false;
        }

        // Обработка дистанции и сутулости
        if (distanceState === "close") {
          activeColor = "#f43f5e";
          mainCard.className = "card video-card state-slouch";
          if (gestureBadge) gestureBadge.innerText = "❌ Слишком близко!";
          alertBox.className = "card alert-card warning";
          alertText.innerText = "🔍 Слишком близко к экрану! Отодвиньтесь.";
          postureStatus.innerText = "БЛИЗКО";
          postureStatus.className = "status-text bad";
          postureBar.style.width = "20%";
          postureBar.style.backgroundColor = "#f43f5e";
          headerDot.className = "status-dot red";
          playWarningSound();
        } else if (distanceState === "far") {
          activeColor = "#f59e0b";
          if (gestureBadge) gestureBadge.innerText = "⚠️ Слишком далеко";
          alertBox.className = "card alert-card warning";
          alertText.innerText = "📐 Слишком далеко от экрана!";
          postureStatus.innerText = "ДАЛЕКО";
          postureStatus.className = "status-text bad";
          postureBar.style.width = "40%";
          postureBar.style.backgroundColor = "#f59e0b";
          headerDot.className = "status-dot yellow";
        } else if (baselineY !== null && !isYawnActive && !isTiltActive) {
          const currentY = lm[1].y;
          const yDiff = currentY - baselineY;

          if (yDiff > 0.065) {
            if (!isSlouchActive) {
              isSlouchActive = true;
              slouchLogs.push(Date.now());
              updateCountersDisplay();
            }
            activeColor = "#f43f5e";
            mainCard.className = "card video-card state-slouch";
            if (gestureBadge) gestureBadge.innerText = "⚠️ Сутулость!";
            alertBox.className = "card alert-card warning";
            alertText.innerText = "⚠️ СУТУЛОСТЬ! Выпрямите спину.";
            postureStatus.innerText = "СПОЛЗЛИ";
            postureStatus.className = "status-text bad";
            postureBar.style.width = "35%";
            postureBar.style.backgroundColor = "#f43f5e";
            headerDot.className = "status-dot red";
            playWarningSound();
          } else {
            isSlouchActive = false;
            mainCard.className = "card video-card";
            if (gestureBadge) gestureBadge.innerText = "🟢 Поза ровная";
            alertBox.className = "card alert-card";
            alertText.innerText = "✅ Входные данные корректны. Дистанция и поза отличные.";
            postureStatus.innerText = "ОК";
            postureStatus.className = "status-text good";
            postureBar.style.width = "100%";
            postureBar.style.backgroundColor = "#10b981";
            headerDot.className = "status-dot green";
          }
        }

        drawFaceSkeleton(lm, activeColor);

        // Расчёт морганий
        const leftEye = [lm[33], lm[160], lm[158], lm[133], lm[153], lm[144]];
        const rightEye = [lm[362], lm[385], lm[387], lm[263], lm[373], lm[380]];
        const avgEAR = (getEAR(leftEye) + getEAR(rightEye)) / 2;

        if (avgEAR < 0.21) {
          if (!isClosed) {
            isClosed = true;
            blinkTimestamps.push(Date.now());
          }
        } else {
          isClosed = false;
        }

        const oneMinuteAgo = Date.now() - 60000;
        blinkTimestamps = blinkTimestamps.filter((t) => t > oneMinuteAgo);
        const blinkRate = blinkTimestamps.length;
        blinkCountEl.innerText = blinkRate;

        // Синхронизация PiP
        if (pipWindow) {
          const pipBadge = pipWindow.document.getElementById("pip-badge");
          const pipText = pipWindow.document.getElementById("pip-text");
          const pipBlink = pipWindow.document.getElementById("pip-blink");

          if (pipBlink) pipBlink.innerText = blinkRate;

          if (pipBadge && pipText) {
            if (distanceState === "close") {
              pipBadge.className = "pip-badge bad";
              pipText.innerText = "БЛИЗКО";
            } else if (distanceState === "far") {
              pipBadge.className = "pip-badge bad";
              pipText.innerText = "ДАЛЕКО";
            } else if (isSlouchActive) {
              pipBadge.className = "pip-badge bad";
              pipText.innerText = "СУТУЛОСТЬ";
            } else {
              pipBadge.className = "pip-badge";
              pipText.innerText = "ОСАНКА ОК";
            }
          }
        }
      }
    }
  }

  requestAnimationFrame(predictWebcam);
}

// Открытие PiP
pipBtn.addEventListener("click", async () => {
  if (pipWindow) {
    pipWindow.close();
    pipWindow = null;
    return;
  }

  if ("documentPictureInPicture" in window) {
    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 250,
        height: 54,
      });

      pipWindow.document.title = "Posture Guard HUD";

      [...document.styleSheets].forEach((sheet) => {
        try {
          const css = [...sheet.cssRules].map((r) => r.cssText).join("");
          const style = document.createElement("style");
          style.textContent = css;
          pipWindow.document.head.appendChild(style);
        } catch (e) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          pipWindow.document.head.appendChild(link);
        }
      });

      pipWindow.document.body.className = "pip-root";
      pipWindow.document.body.innerHTML = `
        <div class="pip-badge" id="pip-badge">
          <div class="pip-led"></div>
          <span class="pip-text" id="pip-text">ОСАНКА ОК</span>
        </div>
        <div class="pip-badge">
          <span class="pip-text">👁️ <span id="pip-blink">${blinkTimestamps.length}</span>/мин</span>
        </div>
      `;

      pipWindow.addEventListener("pagehide", () => {
        pipWindow = null;
      });
    } catch (e) {
      console.error(e);
    }
  } else {
    alert("Ваш браузер не поддерживает Document Picture-in-Picture API.");
  }
});

// Запускаем приложение
init();
