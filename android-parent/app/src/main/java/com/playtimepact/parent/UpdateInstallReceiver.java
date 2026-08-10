package com.playtimepact.parent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

import java.io.File;

/** Explicit PackageInstaller callback; only its pending-user-action intent may be launched. */
public final class UpdateInstallReceiver extends BroadcastReceiver {
  public static final String ACTION_INSTALL_STATUS = "com.playtimepact.parent.UPDATE_INSTALL_STATUS";
  public static final String EXTRA_APK_PATH = "com.playtimepact.parent.extra.UPDATE_APK_PATH";
  private static final String CHANNEL = "update-install-status";

  @Override public void onReceive(Context context, Intent intent) {
    if (!ACTION_INSTALL_STATUS.equals(intent.getAction())) return;
    int status=intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
      Intent confirmation=intent.getParcelableExtra(Intent.EXTRA_INTENT);
      if (confirmation != null && confirmation.getComponent() != null) {
        confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(confirmation);
        notifyStatus(context, "업데이트 설치 확인 필요", "Android 설치 확인 화면을 열었습니다.");
      } else {
        cleanup(context, intent);
        notifyStatus(context, "업데이트 설치 실패", "Android 설치 확인 정보를 안전하게 열 수 없습니다.");
      }
      return;
    }
    cleanup(context, intent);
    String message=intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
    boolean success=status == PackageInstaller.STATUS_SUCCESS;
    notifyStatus(context, success ? "업데이트 완료" : "업데이트 설치 실패", success ? "업데이트 설치가 완료되었습니다." : "업데이트 설치가 완료되지 않았습니다" + (message == null ? "." : ": " + message));
  }

  private static void cleanup(Context context, Intent intent) {
    String path=intent.getStringExtra(EXTRA_APK_PATH);
    if(path == null) return;
    File expected=new File(context.getCacheDir(), "signed-parent-update.apk");
    if(expected.getAbsolutePath().equals(path) && expected.isFile()) expected.delete();
  }
  private static void notifyStatus(Context context, String title, String text) {
    Intent open=new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent pending=PendingIntent.getActivity(context,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
    NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
    if(manager==null)return;
    manager.createNotificationChannel(new NotificationChannel(CHANNEL,"업데이트 설치 상태",NotificationManager.IMPORTANCE_HIGH));
    manager.notify(2002,new Notification.Builder(context,CHANNEL).setSmallIcon(android.R.drawable.stat_sys_download_done).setContentTitle(title).setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text)).setAutoCancel(true).setContentIntent(pending).build());
  }
}
