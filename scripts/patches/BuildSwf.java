import java.io.*;
import java.nio.file.*;
import java.util.*;
import com.jpexs.decompiler.flash.SWF;
import com.jpexs.decompiler.flash.action.*;
import com.jpexs.decompiler.flash.action.swf4.ActionPush;
import com.jpexs.decompiler.flash.action.swf5.ActionCallFunction;
import com.jpexs.decompiler.flash.action.parser.script.ActionScript2Parser;
import com.jpexs.decompiler.flash.configuration.Configuration;
import com.jpexs.decompiler.flash.tags.base.ASMSource;

/** Keep original bytecode except random opcode substitutions and appended net bridge. */
public class BuildSwf {
  static void append(SWF swf, ASMSource source, String text) throws Exception {
    byte[] original = source.getActionBytes().getRangeData();
    List<Action> extra = new ActionScript2Parser(swf, source).actionsFromString(text, "UTF-8");
    byte[] compiled = Action.actionsToBytes(extra, true, swf.version);
    // A separate constant pool is safe: each original function captures its pool at definition.
    ByteArrayOutputStream combined = new ByteArrayOutputStream();
    int length = original.length;
    if (length > 0 && original[length - 1] == 0) length--;
    combined.write(original, 0, length);
    combined.write(compiled);
    source.setActionBytes(combined.toByteArray());
    source.setModified();
  }
  public static void main(String[] args) {
    try { build(args); System.exit(0); } catch(Throwable e) { e.printStackTrace(); System.exit(1); }
  }
  public static void build(String[] args) throws Exception {
    Configuration.autoDeobfuscate.set(false);
    Configuration.parallelSpeedUp.set(false);
    SWF swf = new SWF(new FileInputStream(args[0]), false);
    Map<String, ASMSource> scripts = swf.getASMs(false);
    int count=0, modified=0;
    ASMSource setup=null, gameplay=null;
    for (Map.Entry<String, ASMSource> entry : scripts.entrySet()) {
      String name=entry.getKey();
      if (name.equals("/frame 2 - DoAction")) setup=entry.getValue();
      if (name.equals("/frame 10 - DoAction")) gameplay=entry.getValue();
      ActionList actions=entry.getValue().getActions();
      boolean changed=false;
      for(int i=actions.size()-1;i>=0;i--) {
        if(actions.get(i).getActionCode()!=0x30) continue;
        // Argument n is already on the AVM1 stack. Call the global seeded helper.
        // FFDec repairs relative jumps and nested function lengths for each insertion.
        ActionListReader.addAction(actions,i,new ActionPush(new Object[]{1L,"__gmRandom"},"UTF-8"),false,true);
        ActionListReader.addAction(actions,i+1,new ActionCallFunction(),false,false);
        actions.removeAction(i+2);
        changed=true; count++;
      }
      if(changed) {
        entry.getValue().setActions(actions);
        entry.getValue().setModified();
        modified++;
      }
    }
    if(setup==null || gameplay==null) {
      for(String name:scripts.keySet()) System.err.println(name);
      throw new IllegalStateException("Root frame scripts not found");
    }
    append(swf,setup,Files.readString(Path.of(args[2])));
    append(swf,gameplay,Files.readString(Path.of(args[3])));
    try(OutputStream out=new FileOutputStream(args[1])) { swf.saveTo(out); }
    System.out.println("Patched "+count+" random opcodes in "+modified+" original scripts; appended net bridge in frames 2 and 10.");
  }
}
