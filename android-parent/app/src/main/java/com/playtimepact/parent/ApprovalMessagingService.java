package com.playtimepact.parent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.google.android.gms.tasks.Task;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** FCM contents are opaque wakeups; encrypted tokens are registered only by foreground code. */
public final class ApprovalMessagingService extends FirebaseMessagingService {
  public static final String ACTION_SYNC_REQUIRED="com.playtimepact.parent.ACTION_SYNC_REQUIRED", ACTION_TOKEN_REFRESH_REQUIRED="com.playtimepact.parent.ACTION_TOKEN_REFRESH_REQUIRED";
  private static final String CHANNEL_ID="approval-wakeups", PREFS="playtimepact.fcm", VALUE="encrypted_token", KEY_ALIAS="playtimepact.parent.fcm.v1";
  @Override public void onMessageReceived(RemoteMessage message){sendBroadcast(opaqueWakeupIntent(this,message));notifyWakeup();}
  @Override public void onNewToken(String token){storeToken(this,token);sendBroadcast(new Intent(ACTION_TOKEN_REFRESH_REQUIRED).setPackage(getPackageName()));}
  static Intent opaqueWakeupIntent(Context context,RemoteMessage ignored){return new Intent(ACTION_SYNC_REQUIRED).setPackage(context.getPackageName());}
  public static void requestCurrentToken(Context context,TokenCallback callback){Task<String> task=FirebaseMessaging.getInstance().getToken();task.addOnCompleteListener(result->{if(!result.isSuccessful()||result.getResult()==null||result.getResult().trim().isEmpty()){callback.onFailure(result.getException()==null?new IllegalStateException("FCM token unavailable"):result.getException());return;}try{callback.onToken(storeToken(context,result.getResult()));}catch(Exception e){callback.onFailure(e);}});}
  static synchronized TokenState loadToken(Context context){String value=context.getApplicationContext().getSharedPreferences(PREFS,Context.MODE_PRIVATE).getString(VALUE,null);if(value==null)return null;try{byte[] blob=Base64.decode(value,Base64.NO_WRAP);if(blob.length<=28)throw new SecurityException("Corrupt FCM token");Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,blob,0,12));String plain=new String(cipher.doFinal(blob,12,blob.length-12),StandardCharsets.UTF_8);int separator=plain.indexOf('\n');long version=Long.parseLong(plain.substring(0,separator));String token=plain.substring(separator+1);if(version<=0||token.isEmpty())throw new SecurityException("Invalid FCM token");return new TokenState(token,version);}catch(Exception e){clearToken(context);return null;}}
  static synchronized void clearToken(Context context){context.getApplicationContext().getSharedPreferences(PREFS,Context.MODE_PRIVATE).edit().remove(VALUE).commit();}
  private static synchronized TokenState storeToken(Context context,String token){if(token==null||token.trim().isEmpty())throw new IllegalArgumentException("Invalid FCM token");TokenState prior=loadToken(context);if(prior!=null&&prior.token.equals(token))return prior;long version=prior==null?1:Math.addExact(prior.version,1);try{Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());byte[] iv=cipher.getIV(),encrypted=cipher.doFinal((version+"\n"+token).getBytes(StandardCharsets.UTF_8));byte[] blob=new byte[iv.length+encrypted.length];System.arraycopy(iv,0,blob,0,iv.length);System.arraycopy(encrypted,0,blob,iv.length,encrypted.length);if(!context.getApplicationContext().getSharedPreferences(PREFS,Context.MODE_PRIVATE).edit().putString(VALUE,Base64.encodeToString(blob,Base64.NO_WRAP)).commit())throw new IllegalStateException("Unable to store FCM token");return new TokenState(token,version);}catch(Exception e){throw new IllegalStateException("Unable to protect FCM token",e);}}
  private static SecretKey key()throws Exception{KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);if(!store.containsAlias(KEY_ALIAS)){KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());generator.generateKey();}return ((KeyStore.SecretKeyEntry)store.getEntry(KEY_ALIAS,null)).getSecretKey();}
  private void notifyWakeup(){NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);if(manager==null)return;manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID,"승인 요청 알림",NotificationManager.IMPORTANCE_HIGH));Intent open=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);PendingIntent pending=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);manager.notify(2001,new Notification.Builder(this,CHANNEL_ID).setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("새 플레이 요청을 확인하세요").setContentText("앱을 열어 서버의 최신 상태를 안전하게 확인합니다.").setCategory(Notification.CATEGORY_MESSAGE).setAutoCancel(true).setContentIntent(pending).build());}
  static final class TokenState{final String token;final long version;TokenState(String token,long version){this.token=token;this.version=version;}} public interface TokenCallback{void onToken(TokenState token);void onFailure(Throwable error);}
}
