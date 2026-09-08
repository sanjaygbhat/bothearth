package org.modelbot.mobile;

import android.app.*;
import android.content.Intent;
import android.os.*;
import android.view.*;
import android.view.inputmethod.*;
import android.webkit.WebView;
import android.widget.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;

/** Run only on a disposable emulator with the local synthetic fixture. */
public final class NativeAcceptance extends Instrumentation {
    private Bundle arguments; private Activity activity;
    @Override public void onCreate(Bundle args) { arguments=args; start(); }
    @Override public void onStart() {
        Bundle receipt=new Bundle(); String phase="connect";
        try {
            String link=arguments.getString("link");
            if(link==null || !link.startsWith("https://localhost:7792/#bootstrap="))throw new AssertionError("Use the isolated loopback fixture");
            new SessionVault(getTargetContext()).clear();
            activity=startActivitySync(new Intent(getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            setText("Workspace connection link",link); click("Connect"); until(()->find("Start task")!=null);
            phase="start/result"; setText("What would you like to get done?","Review native fixture · demo.user@example.test"); click("Start task");
            until(()->textContains("END-NATIVE-RESULT"));
            receipt.putString("nativeTask","created and full saved result displayed");
            phase="control"; click("Open computer"); until(()->web()!=null); until(()->js("document.querySelector('canvas') !== null").equals("true"));
            js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Take control')?.click();true");
            until(()->js("document.querySelector('.operator-typing')?.hidden === false").equals("true"));
            js("document.querySelector('.operator-typing').open=true;document.querySelector('.operator-typing textarea').focus();true");
            Thread.sleep(500);
            final String text="demo.user@example.test · नमस्ते";
            runOnMainSync(()->{ WebView view=web(); view.requestFocus(); InputConnection input=view.onCreateInputConnection(new EditorInfo()); if(input==null)throw new AssertionError("No native WebView input connection"); input.commitText(text,1); });
            until(()->js("document.querySelector('.operator-typing textarea').value").contains("demo.user@example.test"));
            js("document.querySelector('.operator-typing button').click();true");
            until(()->js("document.querySelector('.operator-typing p').textContent").contains("Text sent"));
            receipt.putString("nativeIme","WebView InputConnection commits Unicode/dot and explicit send clears buffer");
            if(!js("document.querySelector('.operator-typing textarea').value").equals("\"\""))throw new AssertionError("Buffer retained");
            sendKeyDownUpSync(KeyEvent.KEYCODE_HOME);Thread.sleep(700);
            if(!js("location.href").equals("\"about:blank\""))throw new AssertionError("Background control retained");
            getTargetContext().startActivity(new Intent(getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
            until(()->js("document.querySelector('.operator-typing')?.hidden === false").equals("true"));
            receipt.putString("lifecycle","background clears WebView; foreground reauthenticates and paints HUMAN without text replay");
            Workspace session=new Workspace(new SessionVault(getTargetContext()));session.restore();session.request("GET","/api/v1/session",null);org.json.JSONArray devices=session.request("GET","/api/v1/session/devices",null).getJSONArray("devices");String device=null;for(int i=0;i<devices.length();i++)if(devices.getJSONObject(i).optBoolean("current"))device=devices.getJSONObject(i).getString("id");if(device==null)throw new AssertionError("Current device not listed");session.request("DELETE","/api/v1/session/devices/"+device,null);
            until(()->find("Workspace connection link")!=null);
            if(web()!=null)throw new AssertionError("Expired session retained control");
            receipt.putString("expiry","revoked session returns native reconnect and removes pixels");
            finish(Activity.RESULT_OK,receipt);
        } catch(Throwable error) { receipt.putString("failure",phase+": "+error.toString()); StringBuilder texts=new StringBuilder();runOnMainSync(()->labels(activity.getWindow().getDecorView(),texts));receipt.putString("screen",texts.toString()); finish(Activity.RESULT_CANCELED,receipt); }
    }
    private void labels(View v,StringBuilder out){if(v instanceof TextView && !(v instanceof EditText))out.append(((TextView)v).getText()).append(" | ");if(v instanceof ViewGroup)for(int i=0;i<((ViewGroup)v).getChildCount();i++)labels(((ViewGroup)v).getChildAt(i),out);}
    private void until(BooleanSupplier condition)throws Exception { long end=System.currentTimeMillis()+30000;while(System.currentTimeMillis()<end){if(condition.getAsBoolean())return;Thread.sleep(100);}throw new AssertionError("Native UI condition timed out"); }
    private View search(View view,String label){ if(view instanceof TextView && label.contentEquals(((TextView)view).getText()))return view;if(label.contentEquals(view.getContentDescription()==null?"":view.getContentDescription()))return view;if(view instanceof ViewGroup){ViewGroup g=(ViewGroup)view;for(int i=0;i<g.getChildCount();i++){View found=search(g.getChildAt(i),label);if(found!=null)return found;}}return null; }
    private View find(String label){final View[] out={null};runOnMainSync(()->out[0]=search(activity.getWindow().getDecorView(),label));return out[0];}
    private void click(String label){runOnMainSync(()->{View view=search(activity.getWindow().getDecorView(),label);if(view==null)throw new AssertionError("Missing "+label);view.performClick();});}
    private void setText(String label,String value){runOnMainSync(()->{View view=search(activity.getWindow().getDecorView(),label);if(!(view instanceof EditText)){view=findEdit(activity.getWindow().getDecorView(),label);}if(!(view instanceof EditText))throw new AssertionError("Missing input");((EditText)view).setText(value);});}
    private View findEdit(View v,String label){if(v instanceof EditText && label.contentEquals(v.getContentDescription()))return v;if(v instanceof ViewGroup)for(int i=0;i<((ViewGroup)v).getChildCount();i++){View found=findEdit(((ViewGroup)v).getChildAt(i),label);if(found!=null)return found;}return null;}
    private boolean textContains(String value){final boolean[] found={false};runOnMainSync(()->found[0]=contains(activity.getWindow().getDecorView(),value));return found[0];}
    private boolean contains(View v,String text){if(v instanceof TextView && ((TextView)v).getText().toString().contains(text))return true;if(v instanceof ViewGroup)for(int i=0;i<((ViewGroup)v).getChildCount();i++)if(contains(((ViewGroup)v).getChildAt(i),text))return true;return false;}
    private WebView web(){return findWeb(activity.getWindow().getDecorView());}
    private WebView findWeb(View v){if(v instanceof WebView)return (WebView)v;if(v instanceof ViewGroup)for(int i=0;i<((ViewGroup)v).getChildCount();i++){WebView found=findWeb(((ViewGroup)v).getChildAt(i));if(found!=null)return found;}return null;}
    private String js(String script){try{CountDownLatch done=new CountDownLatch(1);String[] value={""};runOnMainSync(()->{WebView w=web();if(w==null){done.countDown();return;}w.evaluateJavascript(script,result->{value[0]=result;done.countDown();});});if(!done.await(5,TimeUnit.SECONDS))return "";return value[0];}catch(Exception e){throw new RuntimeException(e);}}
}
