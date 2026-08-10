package com.playtimepact.parent;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.os.SystemClock;
import android.content.pm.PackageManager;
import android.content.pm.PackageInstaller;
import android.provider.Settings;
import android.text.InputType;
import androidx.core.content.ContextCompat;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.app.PendingIntent;

import com.google.zxing.client.android.Intents;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanIntentResult;
import com.journeyapps.barcodescanner.ScanOptions;
import androidx.fragment.app.FragmentActivity;

import java.text.DateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/** Parent-facing Android UI. All displayed decisions are refreshed from the authoritative API. */
public final class MainActivity extends FragmentActivity {
  private static final int PURPLE = Color.rgb(91, 75, 219);
  private static final int INK = Color.rgb(29, 28, 42);
  private static final int MUTED = Color.rgb(98, 96, 112);
  private static final int SURFACE = Color.rgb(247, 246, 255);
  private static final int AUTH_REQUEST = 811;
  private static final int NOTIFICATION_PERMISSION_REQUEST = 812;

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService pairingWorker = Executors.newSingleThreadExecutor();
  private PairingStore pairingStore;
  private volatile long serverNowAtElapsedMs;
  private ApprovalRepository repository;
  private LinearLayout root;
  private Runnable pendingAuthenticatedAction;
  private ApprovalRepository.Request selectedRequest;
  private boolean receiverRegistered;

  private final androidx.activity.result.ActivityResultLauncher<ScanOptions> scanner =
      registerForActivityResult(new ScanContract(), this::onScanResult);

  private final BroadcastReceiver wakeupReceiver = new BroadcastReceiver() {
    @Override public void onReceive(Context context, Intent intent) {
      if (ApprovalMessagingService.ACTION_SYNC_REQUIRED.equals(intent.getAction())) {
        if(repository!=null) { renderState(repository.markSyncRequired()); refresh(); }
      } else if (ApprovalMessagingService.ACTION_TOKEN_REFRESH_REQUIRED.equals(intent.getAction())) {
        syncForegroundToken();
      }
    }
  };

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    pairingStore = new PairingStore(this);
    showInitialScreen();
  }

  @Override protected void onStart() {
    super.onStart();
    if (!receiverRegistered) {
      IntentFilter filter = new IntentFilter(ApprovalMessagingService.ACTION_SYNC_REQUIRED);
      filter.addAction(ApprovalMessagingService.ACTION_TOKEN_REFRESH_REQUIRED);
      ContextCompat.registerReceiver(this, wakeupReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
      receiverRegistered = true;
    }
    if(pairingStore != null && pairingStore.isPaired()) { refresh(); syncForegroundToken(); refreshSignedUpdatePolicy(); }
  }

  @Override protected void onStop() {
    if (receiverRegistered) { unregisterReceiver(wakeupReceiver); receiverRegistered = false; }
    super.onStop();
  }
  @Override protected void onResume() {
    super.onResume();
    refreshSignedUpdatePolicy();
  }

  @Override protected void onDestroy() {
    if (repository != null) repository.close();
    pairingWorker.shutdownNow();
    super.onDestroy();
  }

  private void showInitialScreen() {
    if (pairingStore.isPaired()) {
      pairingWorker.execute(() -> {
        try { new RemoteApi(pairingStore, new SecureIdentity(this)).reconcilePendingLifecycle(); runOnUiThread(() -> { showDashboard(); refresh(); }); }
        catch (Exception error) { runOnUiThread(() -> showFailure("중단된 권한 변경을 복구하지 못했습니다", safeMessage(error), this::showInitialScreen)); }
      });
    } else {
      boolean migrationRequired=pairingStore.consumeMigrationRequired();
      showPairing();
      if(migrationRequired) toast("보안 키가 강화되어 새 일회용 QR로 다시 연결해야 합니다.");
    }
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    if(pairingStore.isPaired()) {
      showDashboard();
      refresh();
    }
  }

  private void beginPage() {
    ScrollView scroll = new ScrollView(this);
    root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(dp(24), dp(28), dp(24), dp(40));
    root.setBackgroundColor(SURFACE);
    scroll.addView(root, new ScrollView.LayoutParams(-1, -2));
    setContentView(scroll);
    TextView brand = text("PLAYTIME PACT", 14, true);
    brand.setTextColor(PURPLE);
    brand.setContentDescription("Playtime Pact");
    root.addView(brand);
  }

  private void showPairing() {
    selectedRequest = null;
    beginPage();
    root.addView(text("부모 기기 연결", 31, true));
    root.addView(text("PC에 표시된 일회용 QR 코드를 스캔하세요. 연결 토큰과 기기 키는 이 기기에 암호화되어 저장됩니다.", 16, false));

    LinearLayout security = card();
    security.addView(text("보안 확인", 18, true));
    security.addView(text("승인할 때마다 Android 화면 잠금으로 본인 확인을 요구합니다. 개인 키는 Android Keystore 밖으로 나가지 않습니다.", 14, false));
    root.addView(security, cardParams());

    Button scan = primaryButton("QR 코드 스캔");
    scan.setContentDescription("PC의 연결 QR 코드 스캔");
    scan.setOnClickListener(v -> {
      ScanOptions options = new ScanOptions();
      options.setPrompt("Playtime Pact 연결 QR을 화면 안에 맞추세요");
      options.setBeepEnabled(false);
      options.setOrientationLocked(true);
      options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
      scanner.launch(options);
    });
    root.addView(scan, fullWidth());

    EditText manual = new EditText(this);
    manual.setHint("연결 주소 붙여넣기");
    manual.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    manual.setSingleLine(false);
    manual.setMinLines(2);
    manual.setContentDescription("연결 QR 주소 직접 입력");
    root.addView(manual, fullWidth());
    Button connect = secondaryButton("주소로 연결");
    connect.setOnClickListener(v -> startPairing(manual.getText().toString().trim()));
    root.addView(connect, fullWidth());

    root.addView(text("연결되지 않은 상태에서는 승인 요청이나 가족 정보가 표시되지 않습니다.", 13, false));
    root.addView(updateCard(), cardParams());
  }

  private void onScanResult(ScanIntentResult result) {
    if (result != null && result.getContents() != null) startPairing(result.getContents());
  }

  private void startPairing(String uri) {
    if (uri.isEmpty()) { toast("연결 QR 주소가 비어 있습니다."); return; }
    try { PairingStore.parsePairingUri(uri); }
    catch (Exception error) { toast("유효한 Playtime Pact 연결 QR이 아닙니다."); return; }
    authenticateThen(() -> pairOnWorker(uri));
  }

  private void pairOnWorker(String uri) {
    showBusy("서버에서 일회용 연결 토큰을 확인하고 있습니다…");
    pairingWorker.execute(() -> {
      try {
        new RemoteApi(pairingStore, new SecureIdentity(this)).pair(uri);
        runOnUiThread(() -> { toast("부모 기기가 안전하게 연결되었습니다."); showDashboard(); refresh(); });
      } catch (Exception error) {
        runOnUiThread(() -> showFailure("연결하지 못했습니다", safeMessage(error), this::showPairing));
      }
    });
  }

  private void showDashboard() {
    if (repository != null) repository.close();
    requestNotificationPermission();
    repository = new ApprovalRepository(this, this::runOnUiThread);
    beginPage();
    LinearLayout titleRow = new LinearLayout(this);
    titleRow.setGravity(Gravity.CENTER_VERTICAL);
    TextView title = text("부모 승인", 30, true);
    titleRow.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
    Button refresh = compactButton("새로고침");
    refresh.setOnClickListener(v -> refresh());
    titleRow.addView(refresh);
    root.addView(titleRow);
    renderState(repository.getCachedState());
    syncForegroundToken();
    refreshSignedUpdatePolicy();
  }

  private void refresh() {
    if (repository == null) return;
    repository.refresh(new ApprovalRepository.Callback<ApprovalRepository.State>() {
      @Override public void onSuccess(ApprovalRepository.State state) { renderState(state); }
      @Override public void onFailure(Throwable error) { renderState(repository.getCachedState()); }
    });
  }

  private void renderState(ApprovalRepository.State state) {
    if (state.isFreshNetworkReceipt() && state.getStatus() == ApprovalRepository.Status.ONLINE && state.getServerTimeMillis() > 0) serverNowAtElapsedMs = state.getServerTimeMillis() - SystemClock.elapsedRealtime();
    if (root == null) return;
    beginPage();
    LinearLayout titleRow = new LinearLayout(this);
    titleRow.setGravity(Gravity.CENTER_VERTICAL);
    TextView title = text("부모 승인", 30, true);
    titleRow.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
    Button refresh = compactButton("새로고침"); refresh.setOnClickListener(v -> refresh()); titleRow.addView(refresh);
    root.addView(titleRow);

    TextView status = text(statusText(state), 14, true);
    status.setTextColor(state.getStatus() == ApprovalRepository.Status.ONLINE ? Color.rgb(31, 122, 79) : Color.rgb(190, 87, 45));
    status.setContentDescription("연결 상태 " + statusText(state));
    root.addView(status);
    if (state.getError() != null) root.addView(text("마지막 동기화 오류: " + state.getError(), 13, false));

    LinearLayout summary = card();
    summary.addView(text("오늘 PC·게임별 허용 시간", 14, false));
    summary.addView(text(state.getAllowances().size() + "개 현재 일자 항목", 24, true));
    summary.addView(text("각 PC의 IANA 시간대별 현재 일자는 아래에서 서버 원장으로 표시됩니다.", 12, false));
    if (state.getFetchedAtMillis() > 0) summary.addView(text("마지막 확인 " + DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(state.getFetchedAtMillis())), 12, false));
    root.addView(summary, cardParams());
    for (ApprovalRepository.Allowance allowance : state.getAllowances()) root.addView(allowanceCard(state, allowance), cardParams());
    root.addView(updateCard(), cardParams());

    root.addView(text("요청 기록 " + state.getRequests().size() + "건", 20, true));
    if (state.getRequests().isEmpty()) {
      LinearLayout empty = card();
      empty.addView(text("대기 중인 요청이 없습니다", 17, true));
      empty.addView(text("FCM 알림은 내용 없이 새 요청이 있다는 신호만 보내며, 앱이 서버에서 다시 확인합니다.", 13, false));
      root.addView(empty, cardParams());
    } else {
      for (ApprovalRepository.Request request : state.getRequests()) root.addView(requestCard(request), cardParams());
    }

    root.addView(text("부모 기기 " + state.getDevices().size() + "대", 20, true));
    for (ApprovalRepository.Device device : state.getDevices()) root.addView(deviceCard(device), cardParams());
    Button resetMembership = secondaryButton("분실 기기 복구 · 전체 권한 재설정");
    resetMembership.setOnClickListener(v -> confirm(
        "부모 기기 권한을 모두 재설정할까요?",
        "현재 기기만 새 멤버십 세대의 복구 기기로 남고 다른 부모 기기는 즉시 취소됩니다.",
        () -> {
          showBusy("부모 기기 권한을 재설정하고 있습니다…");
          repository.resetMembership(stateCallback("권한 재설정이 완료되었습니다."));
        }));
    root.addView(resetMembership, fullWidth());

    Button deleteHousehold = secondaryButton("가족 원격 승인 데이터 삭제");
    deleteHousehold.setOnClickListener(v -> confirm(
        "가족 원격 승인 데이터를 삭제할까요?",
        "서버의 가족 멤버십과 원격 승인 권한이 비활성화됩니다. 이 작업은 되돌릴 수 없습니다.",
        () -> {
          showBusy("가족 원격 승인 데이터를 삭제하고 있습니다…");
          repository.deleteHousehold(new ApprovalRepository.Callback<Void>() {
            @Override public void onSuccess(Void ignored) {
              toast("가족 원격 승인 데이터가 삭제되었습니다.");
              if (repository != null) { repository.close(); repository = null; }
              showPairing();
            }
            @Override public void onFailure(Throwable error) {
              showFailure("삭제하지 못했습니다", safeMessage(error), MainActivity.this::showDashboard);
            }
          });
        }));
    root.addView(deleteHousehold, fullWidth());

    Button disconnect = secondaryButton("이 기기 연결 해제");
    disconnect.setOnClickListener(v -> confirm("이 기기 연결을 해제할까요?", "암호화된 연결 토큰과 FCM 등록을 삭제합니다.", () -> {
      showBusy("기기 연결을 해제하고 있습니다…");
      repository.disconnect(new ApprovalRepository.Callback<Void>() {
        @Override public void onSuccess(Void ignored) { if (repository != null) { repository.close(); repository = null; } showPairing(); }
        @Override public void onFailure(Throwable error) { showFailure("연결을 해제하지 못했습니다", safeMessage(error), MainActivity.this::showDashboard); }
      });
    }));
    root.addView(disconnect, fullWidth());
  }
  private View allowanceCard(ApprovalRepository.State state, ApprovalRepository.Allowance allowance) {
    LinearLayout card = card();
    int total = allowance.getTotalSeconds() / 60, committed = allowance.getCommittedSeconds() / 60, reserved = allowance.getReservedSeconds() / 60;
    card.addView(text("오늘 총 시간 · " + allowance.getPcId(), 18, true));
    card.addView(text(allowance.getLocalDay() + " (" + allowance.getTimeZone() + ") · 사용 " + committed + "분 · 예약 " + reserved + "분", 13, false));
    EditText input = new EditText(this);
    input.setInputType(InputType.TYPE_CLASS_NUMBER);
    input.setText(String.valueOf(total));
    input.setContentDescription(allowance.getPcId() + " 오늘 총 시간(분)");
    input.setEnabled(state.getStatus() == ApprovalRepository.Status.ONLINE && isCurrentAllowance(allowance));
    card.addView(input, fullWidth());
    Button save = primaryButton("오늘 총 시간 저장");
    save.setEnabled(state.getStatus() == ApprovalRepository.Status.ONLINE && isCurrentAllowance(allowance));
    save.setOnClickListener(v -> {
      int next;
      try { next = Integer.parseInt(input.getText().toString()); if(next < 0) throw new NumberFormatException(); }
      catch (NumberFormatException error) { input.setError("0분 이상의 정수를 입력하세요"); return; }
      int minimum = (allowance.getCommittedSeconds() + allowance.getReservedSeconds() + 59) / 60;
      if(next < minimum) {
        input.setError("이미 사용 또는 예약된 " + minimum + "분보다 낮출 수 없습니다.");
        toast("서버 기록보다 낮은 총 시간은 저장되지 않습니다.");
        return;
      }
      final int requested = next;
      authenticateThen(() -> saveAllowance(allowance, requested));
    });
    card.addView(save, fullWidth());
    return card;
  }
  private void saveAllowance(ApprovalRepository.Allowance allowance, int totalMinutes) {
    showBusy("서버 기준 오늘 총 시간을 저장하고 있습니다…");
    repository.setTodayAllowance(allowance.getPcId(), allowance.getGameId(), allowance.getVersion(), totalMinutes, new ApprovalRepository.Callback<ApprovalRepository.Allowance>() {
      @Override public void onSuccess(ApprovalRepository.Allowance ignored) { toast("오늘 총 시간이 저장되었습니다."); refresh(); }
      @Override public void onFailure(Throwable error) {
        if (error instanceof RemoteApi.ConflictException) {
          toast("다른 부모 기기의 변경이 있어 최신 서버 상태를 다시 불러옵니다.");
          refresh();
        } else showFailure("오늘 총 시간을 저장하지 못했습니다", safeMessage(error), MainActivity.this::showDashboard);
      }
    });
  }
  private boolean isCurrentAllowance(ApprovalRepository.Allowance allowance) {
    try { return DateTimeFormatter.ISO_LOCAL_DATE.format(Instant.ofEpochMilli(allowance.getServerNowMs()).atZone(ZoneId.of(allowance.getTimeZone()))).equals(allowance.getLocalDay()); }
    catch (Exception error) { return false; }
  }
  private void syncForegroundToken() {
    if(repository == null || !pairingStore.isPaired()) return;
    ApprovalMessagingService.requestCurrentToken(this, new ApprovalMessagingService.TokenCallback() {
      @Override public void onToken(ApprovalMessagingService.TokenState token) {
        if(repository != null) repository.registerFcmToken(token.token, token.version, new ApprovalRepository.Callback<Void>() {
          @Override public void onSuccess(Void ignored) { }
          @Override public void onFailure(Throwable error) { renderState(repository.getCachedState()); }
        });
      }
      @Override public void onFailure(Throwable error) { if(repository != null) renderState(repository.getCachedState()); }
    });
  }
  private View updateCard() {
    LinearLayout card = card();
    card.addView(text("앱 업데이트", 18, true));
    if (!UpdateVerifier.isConfigured(BuildConfig.UPDATE_MANIFEST_URL, BuildConfig.UPDATE_MANIFEST_PUBLIC_KEY)) {
      card.addView(text("이 빌드에는 서명된 업데이트 채널이 구성되지 않았습니다.", 13, false));
      Button unavailable = secondaryButton("업데이트 확인 사용할 수 없음");
      unavailable.setEnabled(false);
      card.addView(unavailable, fullWidth());
      return card;
    }
    card.addView(text("서명된 업데이트 메타데이터를 확인한 뒤 Android 설치 화면으로 넘깁니다.", 13, false));
    Button check = primaryButton("업데이트 확인");
    check.setOnClickListener(v -> checkForUpdate());
    card.addView(check, fullWidth());
    return card;
  }
  private void checkForUpdate() {
    if (!UpdateVerifier.isConfigured(BuildConfig.UPDATE_MANIFEST_URL, BuildConfig.UPDATE_MANIFEST_PUBLIC_KEY)) {
      toast("이 빌드에는 서명된 업데이트 채널이 구성되지 않았습니다.");
      return;
    }
    showBusy("서명된 업데이트 정보를 확인하고 있습니다…");
    pairingWorker.execute(() -> {
      try {
        long installed = getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
        UpdateVerifier.VerifiedUpdate update = UpdateVerifier.fetchManifest(BuildConfig.UPDATE_MANIFEST_URL, BuildConfig.UPDATE_MANIFEST_PUBLIC_KEY, installed);
        UpdateVerifier.persistMinimumSupportedVersion(this, update);
        runOnUiThread(() -> new AlertDialog.Builder(this)
            .setTitle("업데이트 " + update.versionName)
            .setMessage(update.releaseNotes + "\n\n다운로드 크기: " + (update.sizeBytes / 1024 / 1024) + "MB\nAndroid 설치 확인 화면이 열립니다.")
            .setNegativeButton("취소", (dialog, which) -> showInitialScreen())
            .setPositiveButton("다운로드 및 설치", (dialog, which) -> downloadAndInstall(update))
            .show());
      } catch (Exception error) {
        runOnUiThread(() -> showFailure("업데이트를 확인하지 못했습니다", safeMessage(error), this::showInitialScreen));
      }
    });
  }
  private void refreshSignedUpdatePolicy() {
    if (!UpdateVerifier.isConfigured(BuildConfig.UPDATE_MANIFEST_URL, BuildConfig.UPDATE_MANIFEST_PUBLIC_KEY)) return;
    UpdateVerifier.beginForegroundPolicyRefresh(this);
    pairingWorker.execute(() -> {
      try { UpdateVerifier.persistMinimumSupportedVersion(this, UpdateVerifier.fetchPolicy(BuildConfig.UPDATE_MANIFEST_URL, BuildConfig.UPDATE_MANIFEST_PUBLIC_KEY)); }
      catch (Exception ignored) { /* A previously verified policy remains valid; unknown policy blocks mutations offline. */ }
      finally { UpdateVerifier.endForegroundPolicyRefresh(this); }
    });
  }
  private void downloadAndInstall(UpdateVerifier.VerifiedUpdate update) {
    if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
      showFailure("알 수 없는 앱 설치 권한이 필요합니다", "Android 설정에서 Playtime Pact Parent의 앱 설치를 허용한 뒤 서명된 업데이트를 다시 확인하세요.", () -> startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, android.net.Uri.parse("package:" + getPackageName()))));
      return;
    }
    showBusy("업데이트 APK를 다운로드하고 서명을 확인하고 있습니다…");
    pairingWorker.execute(() -> {
      File apk = new File(getCacheDir(), "signed-parent-update.apk");
      try {
        UpdateVerifier.downloadApk(update, apk);
        UpdateVerifier.verifyApk(apk, update);
        UpdateVerifier.verifySignerLineage(getPackageManager(), getPackageName(), apk, update);
        runOnUiThread(() -> handoffToPackageInstaller(apk, update));
      } catch (Exception error) {
        if (apk.exists()) apk.delete();
        runOnUiThread(() -> showFailure("업데이트를 설치할 수 없습니다", safeMessage(error), this::showInitialScreen));
      }
    });
  }
  private void handoffToPackageInstaller(File apk, UpdateVerifier.VerifiedUpdate update) {
    PackageInstaller.Session session = null;
    try {
      PackageInstaller installer = getPackageManager().getPackageInstaller();
      PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
      params.setAppPackageName(getPackageName());
      int sessionId = installer.createSession(params);
      session = installer.openSession(sessionId);
      try (FileInputStream input = new FileInputStream(apk); OutputStream output = session.openWrite("base.apk", 0, update.sizeBytes)) {
        byte[] buffer = new byte[32 * 1024]; int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        session.fsync(output);
      }
      int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
      Intent callback = new Intent(this, UpdateInstallReceiver.class).setAction(UpdateInstallReceiver.ACTION_INSTALL_STATUS)
          .putExtra(UpdateInstallReceiver.EXTRA_APK_PATH, apk.getAbsolutePath());
      PendingIntent status = PendingIntent.getBroadcast(this, sessionId, callback, flags);
      session.commit(status.getIntentSender());
      session.close();
      toast("Android 설치 확인 화면으로 업데이트를 전달했습니다.");
    } catch (Exception error) {
      if (session != null) { try { session.abandon(); session.close(); } catch (Exception ignored) { } }
      if (apk.exists()) apk.delete();
      showFailure("Android 설치 화면을 열지 못했습니다", safeMessage(error), this::showInitialScreen);
    }
  }

  private View requestCard(ApprovalRepository.Request request) {
    LinearLayout card = card();
    TextView badge = text(requestStatusText(request), 13, true); badge.setTextColor(isRequestActionable(request) ? Color.rgb(203, 74, 55) : MUTED); card.addView(badge);
    card.addView(text(request.getChildName() + "의 플레이 요청", 21, true));
    card.addView(text(request.getDeviceName() + " · " + request.getGameName(), 15, false));
    card.addView(text("오늘 " + request.getTodayUsedMinutes() + "분 / " + request.getTodayLimitMinutes() + "분", 15, false));
    Button open = isRequestActionable(request) ? primaryButton("요청 검토") : secondaryButton("결과 보기"); open.setOnClickListener(v -> showRequest(request)); card.addView(open, fullWidth());
    return card;
  }

  private void showRequest(ApprovalRepository.Request request) {
    selectedRequest = request;
    beginPage();
    Button back = secondaryButton("← 요청 목록"); back.setOnClickListener(v -> renderState(repository.getCachedState())); root.addView(back, fullWidth());
    root.addView(text(request.getGameName() + " 플레이 승인", 28, true));
    TextView expiry = text(requestStatusText(request), 15, true); expiry.setTextColor(Color.rgb(203, 74, 55)); root.addView(expiry);
    root.addView(text("승인은 게임을 자동 실행하지 않습니다. PC에서 같은 요청을 다시 확인한 뒤 사용자가 직접 실행합니다.", 14, false));
    root.addView(text("오늘 사용 " + request.getTodayUsedMinutes() + "분 / " + request.getTodayLimitMinutes() + "분", 17, true));
    if (!isRequestActionable(request)) {
      root.addView(text(requestOutcomeText(request), 17, true));
      root.addView(text("이 요청은 더 이상 변경할 수 없습니다.", 14, false));
      return;
    }
    root.addView(text("플레이 시간", 19, true));

    int[] minutePresets = new int[]{10,20,30,40,50,60};
    for(int rowIndex=0;rowIndex<2;rowIndex++) {
      LinearLayout presets = new LinearLayout(this); presets.setOrientation(LinearLayout.HORIZONTAL);
      for(int column=0;column<3;column++) {
        int minutes=minutePresets[rowIndex*3+column];
        Button preset=compactButton(minutes+"분");
        preset.setOnClickListener(v -> approve(request,minutes));
        presets.addView(preset,new LinearLayout.LayoutParams(0,dp(52),1));
      }
      root.addView(presets,fullWidth());
    }

    EditText manual = new EditText(this); manual.setHint("직접 입력 (1~240분)"); manual.setInputType(InputType.TYPE_CLASS_NUMBER); manual.setContentDescription("승인 시간 직접 입력"); root.addView(manual, fullWidth());
    Button approveDefault = primaryButton("기본 20분 승인"); approveDefault.setOnClickListener(v -> approve(request, ApprovalRepository.DEFAULT_APPROVAL_MINUTES)); root.addView(approveDefault, fullWidth());
    Button approveManual = secondaryButton("입력한 시간 승인"); approveManual.setOnClickListener(v -> {
      try { int minutes = Integer.parseInt(manual.getText().toString()); if (minutes < 1 || minutes > 240) throw new NumberFormatException(); approve(request, minutes); }
      catch (NumberFormatException error) { manual.setError("1~240분을 입력하세요"); }
    }); root.addView(approveManual, fullWidth());
    Button reject = secondaryButton("나만 거절"); reject.setOnClickListener(v -> reject(request)); root.addView(reject, fullWidth());
  }
  private boolean isRequestActionable(ApprovalRepository.Request request) {
    return "pending".equals(request.getStatus())
        && request.getPersonalDecision()==null
        && authoritativeNowMs()<request.getExpiresAtMillis();
  }

  private String requestStatusText(ApprovalRepository.Request request) {
    if("approved".equals(request.getStatus()) && "reject".equals(request.getPersonalDecision())) return "내 거절 후 다른 부모 승인";
    if("reject".equals(request.getPersonalDecision())) return "이 기기에서 거절함";
    if("approved".equals(request.getStatus())) return "승인 완료";
    if("expired".equals(request.getStatus()) || authoritativeNowMs()>=request.getExpiresAtMillis()) return "요청 만료";
    return expiryText(request);
  }

  private String requestOutcomeText(ApprovalRepository.Request request) {
    if("approved".equals(request.getStatus()) && "reject".equals(request.getPersonalDecision())) return "이 부모 기기는 거절했지만 다른 동등한 부모 기기가 먼저 승인했습니다.";
    if("reject".equals(request.getPersonalDecision())) return "이 부모 기기는 이 요청을 거절했습니다. 다른 부모 기기는 계속 승인할 수 있습니다.";
    if("approved".equals(request.getStatus())) return "다른 부모 기기를 포함한 승인 중 하나가 먼저 완료되었습니다.";
    return "서버 기준 5분의 승인 시간이 지나 요청이 만료되었습니다.";
  }

  private void approve(ApprovalRepository.Request request, int minutes) {
    showBusy(minutes + "분 승인을 서버에 기록하고 있습니다…");
    repository.approve(request.getId(), minutes, stateCallback("승인이 완료되었습니다."));
  }

  private void reject(ApprovalRepository.Request request) {
    confirm("이 기기에서만 거절할까요?", "다른 동등한 부모 기기는 계속 승인할 수 있습니다.", () -> {
      showBusy("개인 거절을 기록하고 있습니다…");
      repository.rejectPersonally(request.getId(), stateCallback("개인 거절을 기록했습니다."));
    });
  }

  private View deviceCard(ApprovalRepository.Device device) {
    LinearLayout card = card();
    card.addView(text(device.getName(), 17, true));
    card.addView(text(device.getPlatform() + " · " + device.getStatus(), 13, false));
    Button revoke = compactButton(isCurrentDevice(device.getId()) ? "현재 기기" : "권한 취소");
    revoke.setEnabled(!isCurrentDevice(device.getId()));
    revoke.setOnClickListener(v -> deviceAction("이 부모 기기의 권한을 취소할까요?", () -> repository.revokeDevice(device.getId(), stateCallback("기기 권한을 취소했습니다."))));
    card.addView(revoke, fullWidth());
    return card;
  }

  private void deviceAction(String title, Runnable action) {
    confirm(title, "모든 부모 기기는 동등한 권한을 가집니다. 변경은 서버에서 즉시 적용됩니다.", () -> { showBusy("기기 권한을 갱신하고 있습니다…"); action.run(); });
  }
  private boolean isCurrentDevice(String deviceId) {
    try {
      PairingStore.Pairing pairing = pairingStore.load();
      return pairing != null && pairing.getParentId().equals(deviceId);
    } catch (PairingStore.PairingException error) {
      return false;
    }
  }
  private void requestNotificationPermission() {
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(
          new String[]{Manifest.permission.POST_NOTIFICATIONS},
          NOTIFICATION_PERMISSION_REQUEST);
    }
  }

  private ApprovalRepository.Callback<ApprovalRepository.State> stateCallback(String success) {
    return new ApprovalRepository.Callback<ApprovalRepository.State>() {
      @Override public void onSuccess(ApprovalRepository.State state) { toast(success); renderState(state); }
      @Override public void onFailure(Throwable error) { showFailure("요청을 완료하지 못했습니다", safeMessage(error), MainActivity.this::showDashboard); }
    };
  }

  private void authenticateThen(Runnable action) {
    KeyguardManager keyguard = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
    if (keyguard == null || !keyguard.isDeviceSecure()) {
      showFailure("화면 잠금이 필요합니다", "Android 설정에서 PIN, 패턴 또는 생체 인증을 설정한 뒤 다시 시도하세요.", () -> startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS)));
      return;
    }
    pendingAuthenticatedAction = action;
    Intent intent = keyguard.createConfirmDeviceCredentialIntent("부모 승인 확인", "Playtime Pact 보안 키 사용을 허용하세요");
    if (intent == null) { pendingAuthenticatedAction = null; showFailure("본인 확인을 시작할 수 없습니다", "화면 잠금 설정을 확인하세요.", this::showInitialScreen); return; }
    startActivityForResult(intent, AUTH_REQUEST);
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode == AUTH_REQUEST) {
      Runnable action = pendingAuthenticatedAction; pendingAuthenticatedAction = null;
      if (resultCode == RESULT_OK && action != null) action.run(); else toast("본인 확인이 취소되었습니다.");
    }
  }

  private void showBusy(String message) {
    beginPage();
    ProgressBar progress = new ProgressBar(this); progress.setIndeterminate(true); progress.setContentDescription("처리 중"); root.addView(progress, new LinearLayout.LayoutParams(-1, dp(72)));
    TextView label = text(message, 17, true); label.setGravity(Gravity.CENTER); root.addView(label);
  }

  private void showFailure(String title, String detail, Runnable retry) {
    beginPage();
    root.addView(text(title, 27, true));
    root.addView(text(detail, 15, false));
    Button button = primaryButton("다시 시도"); button.setOnClickListener(v -> retry.run()); root.addView(button, fullWidth());
    Button pairing = secondaryButton("연결 설정으로 이동"); pairing.setOnClickListener(v -> showPairing()); root.addView(pairing, fullWidth());
  }

  private void confirm(String title, String detail, Runnable action) {
    new AlertDialog.Builder(this).setTitle(title).setMessage(detail).setNegativeButton("취소", null).setPositiveButton("계속", (dialog, which) -> action.run()).show();
  }

  private String statusText(ApprovalRepository.State state) {
    switch (state.getStatus()) {
      case ONLINE: return "서버 연결됨 · 최신 상태";
      case STALE: return "오프라인 · 마지막 확인 상태";
      case ERROR: return "동기화 오류 · 변경 작업 중지";
      default: return "서버 연결 확인 중";
    }
  }

  private String expiryText(ApprovalRepository.Request request) {
    long remaining = Math.max(0, request.getExpiresAtMillis() - authoritativeNowMs());
    return String.format(Locale.KOREA, "승인 대기 · %02d:%02d", remaining / 60000, (remaining / 1000) % 60);
  }
  private long authoritativeNowMs() { return serverNowAtElapsedMs == 0 ? Long.MAX_VALUE : serverNowAtElapsedMs + SystemClock.elapsedRealtime(); }

  private LinearLayout card() {
    LinearLayout card = new LinearLayout(this); card.setOrientation(LinearLayout.VERTICAL); card.setPadding(dp(20), dp(18), dp(20), dp(18)); card.setBackgroundColor(Color.WHITE); card.setElevation(dp(2)); return card;
  }

  private LinearLayout.LayoutParams cardParams() { LinearLayout.LayoutParams params = fullWidth(); params.setMargins(0, dp(12), 0, dp(12)); return params; }
  private LinearLayout.LayoutParams fullWidth() { LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, dp(6), 0, dp(6)); return params; }

  private TextView text(String value, int size, boolean bold) {
    TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(bold ? INK : MUTED); view.setTypeface(Typeface.DEFAULT, bold ? Typeface.BOLD : Typeface.NORMAL); view.setLineSpacing(0, 1.15f); view.setPadding(0, dp(5), 0, dp(5)); return view;
  }

  private Button primaryButton(String label) { Button button = button(label); button.setTextColor(Color.WHITE); button.setBackgroundColor(PURPLE); return button; }
  private Button secondaryButton(String label) { Button button = button(label); button.setTextColor(INK); button.setBackgroundColor(Color.rgb(231, 230, 239)); return button; }
  private Button compactButton(String label) { Button button = secondaryButton(label); button.setTextSize(13); return button; }
  private Button button(String label) { Button button = new Button(this); button.setText(label); button.setAllCaps(false); button.setMinHeight(dp(48)); button.setGravity(Gravity.CENTER); return button; }
  private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
  private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
  private String safeMessage(Throwable error) { String message = error == null ? null : error.getMessage(); return message == null || message.trim().isEmpty() ? "네트워크와 연결 상태를 확인하세요." : message; }
}
