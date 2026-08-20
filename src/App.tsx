import React, { useState, useEffect, useRef, useCallback } from 'react';
import { DIFFICULTY_SETTINGS, SHIP_COLORS } from './constants/gameConfig';
import { soundManager } from './audio/soundManager';
import { GameCanvas } from './components/GameCanvas';
import { HUD } from './components/HUD';
import { StartScreen } from './components/StartScreen';
import { SplashScreen, SPLASH_EXIT_MS } from './components/SplashScreen';
import { HangarScreen } from './components/HangarScreen';
import { GameOverScreen } from './components/GameOverScreen';
import { ShopScreen } from './components/ShopScreen';
import { DifficultyKey, GameOverSummary, GameState, ModulePreview, ModuleStatus, ModuleType, ShipColorKey, ShipModelId } from './types/game';
import { GameEngine } from './game/GameEngine';
import './styles/index.css';
import './styles/ui.css';

/**
 * Extra time the menu warp-in runs past the splash warp-out, covering the
 * staggered panel entrances that land after the backdrop has settled.
 */
const MENU_INTRO_TAIL_MS = 500;

/** Hangar module-fitting toggles, remembered between sessions. */
const MODULE_PREVIEW_KEY = 'hoverbird_module_preview';
const NO_MODULE_PREVIEW: ModulePreview = { powerGen: false, autoCannon: false, zoomScanner: false };

export const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>('START');
  const [menuMode, setMenuMode] = useState<'HOME' | 'HANGAR'>('HOME');
  const [showSplash, setShowSplash] = useState<boolean>(true);
  // Drives the 1s home-menu warp-in that runs underneath the splash warp-out.
  const [menuIntro, setMenuIntro] = useState<boolean>(false);

  const menuIntroTimerRef = useRef<number | null>(null);

  // Stable so it does not restart the splash timers when App re-renders.
  const handleSplashExitStart = useCallback(() => {
    if (menuIntroTimerRef.current !== null) {
      window.clearTimeout(menuIntroTimerRef.current);
    }
    setMenuIntro(true);
    // Dropped once the warp-in has played out; leaving the class on would keep
    // the animation attached to the menu.
    menuIntroTimerRef.current = window.setTimeout(() => {
      menuIntroTimerRef.current = null;
      setMenuIntro(false);
    }, SPLASH_EXIT_MS + MENU_INTRO_TAIL_MS);
  }, []);

  const handleSplashFinish = useCallback(() => setShowSplash(false), []);

  useEffect(
    () => () => {
      if (menuIntroTimerRef.current !== null) {
        window.clearTimeout(menuIntroTimerRef.current);
      }
    },
    []
  );

  const [currentDifficulty, setCurrentDifficulty] = useState<DifficultyKey>('normal');
  const [currentShipColor, setCurrentShipColor] = useState<ShipColorKey>('blue');
  const [currentShipModel, setCurrentShipModel] = useState<ShipModelId>('dart');
  const [unlockedShips, setUnlockedShips] = useState<ShipModelId[]>(['dart']);
  const [totalGems, setTotalGems] = useState<number>(0);
  const [modulePreview, setModulePreview] = useState<ModulePreview>(NO_MODULE_PREVIEW);

  const [score, setScore] = useState<number>(0);
  const [runGems, setRunGems] = useState<number>(0);
  const [highScore, setHighScore] = useState<number>(0);

  const [level, setLevel] = useState<number>(1);
  const [enemiesSurvived, setEnemiesSurvived] = useState<number>(0);
  const [runTimeSec, setRunTimeSec] = useState<number>(0);
  const [levelProgress, setLevelProgress] = useState<number>(0); // 0 to 1
  const [threatsRemaining, setThreatsRemaining] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [menuPaused, setMenuPaused] = useState<boolean>(false);

  // In-run ship modules (not persisted between games)
  const [isShopOpen, setIsShopOpen] = useState<boolean>(false);
  const [powerGenLevel, setPowerGenLevel] = useState<number>(0);
  const [zoomScannerLevel, setZoomScannerLevel] = useState<number>(0);
  const [autoCannonLevel, setAutoCannonLevel] = useState<number>(0);
  const [moduleStatus, setModuleStatus] = useState<ModuleStatus>({
    powerGenLevel: 0,
    autoCannonLevel: 0,
    zoomScannerLevel: 0,
    shieldActive: true,
    shieldRegenProgress: 1,
    cannonProgress: 0,
    shieldCharges: 1,
    maxShieldCharges: 1,
    trueVisionActive: false
  });

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GameEngine | null>(null);

  const getHighScoreKey = (diff: DifficultyKey): string => `hoverbird_highscore_${diff}`;

  // Load persistent stats, unlocks, and URL debug parameters on mount
  useEffect(() => {
    // Check URL search parameters for debug gem amount (e.g. ?gems=500)
    const urlParams = new URLSearchParams(window.location.search);
    const debugGemsParam = urlParams.get('gems') || urlParams.get('debugGems');

    let initialGems = 0;
    if (debugGemsParam !== null && !isNaN(parseInt(debugGemsParam, 10))) {
      initialGems = parseInt(debugGemsParam, 10);
      localStorage.setItem('hoverbird_total_gems', initialGems.toString());
    } else {
      initialGems = parseInt(localStorage.getItem('hoverbird_total_gems') || '0', 10) || 0;
    }
    setTotalGems(initialGems);

    // Ship color
    const savedColor = localStorage.getItem('hoverbird_ship_color') as ShipColorKey;
    if (savedColor && SHIP_COLORS[savedColor]) {
      setCurrentShipColor(savedColor);
    }

    // Unlocked ships
    try {
      const savedUnlocked = JSON.parse(localStorage.getItem('hoverbird_unlocked_ships') || '["dart"]');
      if (Array.isArray(savedUnlocked)) {
        setUnlockedShips(savedUnlocked);
      }
    } catch {
      setUnlockedShips(['dart']);
    }

    // Active ship model
    const savedShip = localStorage.getItem('hoverbird_active_ship') as ShipModelId;
    if (savedShip) {
      setCurrentShipModel(savedShip);
    }

    // Hangar module-fitting toggles
    try {
      const savedPreview = JSON.parse(localStorage.getItem(MODULE_PREVIEW_KEY) || 'null');
      if (savedPreview && typeof savedPreview === 'object') {
        setModulePreview({
          powerGen: !!savedPreview.powerGen,
          autoCannon: !!savedPreview.autoCannon,
          zoomScanner: !!savedPreview.zoomScanner
        });
      }
    } catch {
      setModulePreview(NO_MODULE_PREVIEW);
    }

    // Fullscreen change listener
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      // Trigger canvas resize update
      if (engineRef.current) {
        setTimeout(() => {
          if (engineRef.current) engineRef.current.onResize();
        }, 100);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Update theme colors and load high score on difficulty change
  useEffect(() => {
    const savedScore = parseInt(localStorage.getItem(getHighScoreKey(currentDifficulty)) || '0', 10) || 0;
    setHighScore(savedScore);

    const config = DIFFICULTY_SETTINGS[currentDifficulty] || DIFFICULTY_SETTINGS.normal;
    document.documentElement.style.setProperty('--theme-color', config.themeColor);
    document.documentElement.style.setProperty('--theme-glow', config.themeGlow);
  }, [currentDifficulty]);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        const targetElem = wrapperRef.current || containerRef.current || document.documentElement;
        if (targetElem.requestFullscreen) {
          await targetElem.requestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch (err) {
      console.warn('Fullscreen error:', err);
    }
  };

  const handleStartGame = (): void => {
    soundManager.init();
    setScore(0);
    setRunGems(0);
    setLevel(1);
    setEnemiesSurvived(0);
    setRunTimeSec(0);
    setLevelProgress(0);
    setIsShopOpen(false);
    setPowerGenLevel(0);
    setZoomScannerLevel(0);
    setAutoCannonLevel(0);
    setGameState('PLAYING');
    if (engineRef.current) {
      engineRef.current.setTotalGems(totalGems);
      engineRef.current.startGame();
    }
  };

  const handleGameOver = (summary: GameOverSummary): void => {
    setScore(summary.score);
    setRunGems(summary.gemsCollected);
    setLevel(summary.level);
    setEnemiesSurvived(summary.enemiesSurvived);
    setRunTimeSec(summary.runTimeSec);

    const storageKey = getHighScoreKey(currentDifficulty);
    const savedHighScore = parseInt(localStorage.getItem(storageKey) || '0', 10) || 0;

    if (summary.score > savedHighScore) {
      localStorage.setItem(storageKey, summary.score.toString());
      setHighScore(summary.score);
    }

    // Persist verified total gems bank to localStorage
    const savedGems = parseInt(localStorage.getItem('hoverbird_total_gems') || '0', 10) || totalGems;
    setTotalGems(savedGems);

    setGameState('GAMEOVER');
  };

  const handleGoToTitle = (): void => {
    setGameState('START');
    setMenuMode('HOME');
    if (engineRef.current) {
      engineRef.current.goToTitleScreen();
    }
  };

  const handleSelectDifficulty = (diffKey: DifficultyKey): void => {
    setCurrentDifficulty(diffKey);
  };

  const handleSelectShipColor = (colorKey: ShipColorKey): void => {
    setCurrentShipColor(colorKey);
    localStorage.setItem('hoverbird_ship_color', colorKey);
  };

  const handleToggleModulePreview = (type: ModuleType): void => {
    setModulePreview((prev) => {
      const next = { ...prev, [type]: !prev[type] };
      localStorage.setItem(MODULE_PREVIEW_KEY, JSON.stringify(next));
      return next;
    });
  };

  const handleSelectShipModel = (modelId: ShipModelId): void => {
    setCurrentShipModel(modelId);
    localStorage.setItem('hoverbird_active_ship', modelId);
  };

  const handleUnlockShip = (modelId: ShipModelId, cost: number): void => {
    if (totalGems >= cost && !unlockedShips.includes(modelId)) {
      const newGems = totalGems - cost;
      const newUnlocked = [...unlockedShips, modelId];

      setTotalGems(newGems);
      setUnlockedShips(newUnlocked);
      setCurrentShipModel(modelId);

      localStorage.setItem('hoverbird_total_gems', newGems.toString());
      localStorage.setItem('hoverbird_unlocked_ships', JSON.stringify(newUnlocked));
      localStorage.setItem('hoverbird_active_ship', modelId);

      if (engineRef.current) {
        engineRef.current.setTotalGems(newGems);
      }
    }
  };

  const handleGemsUpdate = (runG: number, totalG: number): void => {
    setRunGems(runG);
    setTotalGems(totalG);
    localStorage.setItem('hoverbird_total_gems', totalG.toString());
  };

  const handleLevelProgress = (progressSec: number, totalSec: number): void => {
    setLevelProgress(progressSec / totalSec);
  };

  const handleLevelUp = (newLevel: number): void => {
    setLevel(newLevel);
  };

  const handleModuleStatus = (status: ModuleStatus): void => {
    setModuleStatus(status);
  };

  const handleOpenShop = (): void => {
    setIsShopOpen(true);
  };

  const handleCloseShop = (): void => {
    setIsShopOpen(false);
  };

  const handlePurchaseModule = (type: ModuleType): void => {
    if (!engineRef.current) return;
    const ok = engineRef.current.purchaseModule(type);
    if (ok) {
      setPowerGenLevel(engineRef.current.powerGenLevel);
      setAutoCannonLevel(engineRef.current.autoCannonLevel);
      setZoomScannerLevel(engineRef.current.zoomScannerLevel);
      // purchaseModule already fired onGemsUpdate to sync the gem bank
    }
  };

  // Ensure the shop closes whenever we leave the warp window
  useEffect(() => {
    if (gameState !== 'WARPING' && isShopOpen) {
      setIsShopOpen(false);
    }
  }, [gameState, isShopOpen]);

  // Single source of truth for pausing the simulation: pause whenever the
  // shop or the in-game menu is open. This avoids competing setPaused calls.
  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setPaused(isShopOpen || menuPaused);
    }
  }, [isShopOpen, menuPaused]);

  return (
    <div className={`game-wrapper ${isFullscreen ? 'is-fullscreen' : ''}`} ref={wrapperRef}>
      <div className="game-container" ref={containerRef}>
        <GameCanvas
          engineRef={engineRef}
          currentDifficulty={currentDifficulty}
          currentShipColor={currentShipColor}
          currentShipModel={currentShipModel}
          totalGems={totalGems}
          zoomScannerLevel={zoomScannerLevel}
          modulePreview={modulePreview}
          isHangarMode={gameState === 'START' && menuMode === 'HANGAR'}
          isWarping={gameState === 'WARPING'}
          onScoreUpdate={setScore}
          onGemsUpdate={handleGemsUpdate}
          onGameOver={handleGameOver}
          onLevelUp={handleLevelUp}
          onLevelProgress={handleLevelProgress}
          onModuleStatus={handleModuleStatus}
          onThreatCount={setThreatsRemaining}
          onGameStateChange={setGameState}
        />

        <HUD
          score={score}
          highScore={highScore}
          gems={runGems}
          totalGems={totalGems}
          level={level}
          levelProgress={levelProgress}
          threatsRemaining={threatsRemaining}
          currentDifficulty={currentDifficulty}
          currentShipModel={currentShipModel}
          moduleStatus={moduleStatus}
          gameState={gameState}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
          onHome={handleGoToTitle}
          onRestart={handleStartGame}
          onPauseChange={setMenuPaused}
        />

        {/* Main Home Screen */}
        <StartScreen
          isVisible={gameState === 'START' && menuMode === 'HOME'}
          isIntroAnimating={menuIntro}
          onStart={handleStartGame}
          onOpenHangar={() => setMenuMode('HANGAR')}
          currentDifficulty={currentDifficulty}
          onSelectDifficulty={handleSelectDifficulty}
          currentShipModel={currentShipModel}
          onSelectShipModel={handleSelectShipModel}
          unlockedShips={unlockedShips}
          currentShipColor={currentShipColor}
          totalGems={totalGems}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
        />

        {/* Dedicated Hangar / Ship Configuration Screen */}
        <HangarScreen
          isVisible={gameState === 'START' && menuMode === 'HANGAR'}
          currentShipModel={currentShipModel}
          unlockedShips={unlockedShips}
          totalGems={totalGems}
          currentShipColor={currentShipColor}
          modulePreview={modulePreview}
          onSelectShipModel={handleSelectShipModel}
          onUnlockShip={handleUnlockShip}
          onSelectShipColor={handleSelectShipColor}
          onToggleModulePreview={handleToggleModulePreview}
          onBackToMenu={() => setMenuMode('HOME')}
        />

        <GameOverScreen
          isVisible={gameState === 'GAMEOVER'}
          score={score}
          gems={runGems}
          totalGems={totalGems}
          level={level}
          highScore={highScore}
          enemiesSurvived={enemiesSurvived}
          runTimeSec={runTimeSec}
          currentDifficulty={currentDifficulty}
          onSelectDifficulty={handleSelectDifficulty}
          onRestart={handleStartGame}
          onHome={handleGoToTitle}
        />

        {/* Shop access button during the spacewarp window */}
        {gameState === 'WARPING' && !isShopOpen && (
          <button type="button" className="btn shop-open-btn" onClick={handleOpenShop}>
            🛒 OPEN MODULE SHOP
          </button>
        )}

        <ShopScreen
          isVisible={gameState === 'WARPING' && isShopOpen}
          totalGems={totalGems}
          powerGenLevel={powerGenLevel}
          autoCannonLevel={autoCannonLevel}
          zoomScannerLevel={zoomScannerLevel}
          onPurchase={handlePurchaseModule}
          onClose={handleCloseShop}
        />

        <SplashScreen
          isVisible={showSplash}
          onExitStart={handleSplashExitStart}
          onFinish={handleSplashFinish}
        />
      </div>
    </div>
  );
};

export default App;
