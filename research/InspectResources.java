import java.io.*;
import java.util.*;
import com.jpexs.decompiler.flash.SWF;
import com.jpexs.decompiler.flash.tags.*;
import com.jpexs.decompiler.flash.tags.base.*;
class InspectResources {
 static SWF swf;
 static void inspect(Iterable<Tag> tags,String parent) {
  int frame=1;
  for(Tag t:tags) {
   if(t instanceof ShowFrameTag) frame++;
   if(t instanceof PlaceObjectTypeTag) {
    PlaceObjectTypeTag p=(PlaceObjectTypeTag)t;
    String name=p.getInstanceName();
    if(Arrays.asList(811,813,817,831,833).contains(p.getCharacterId())) System.out.println("CHOICE "+parent+" frame "+frame+" sprite "+p.getCharacterId()+" x="+p.getMatrix().translateX/20.0+" y="+p.getMatrix().translateY/20.0);
    if(parent.equals("sprite1230") && swf.getCharacter(p.getCharacterId()) instanceof TextTag) System.out.println("MAPTEXT frame "+frame+" "+((TextTag)swf.getCharacter(p.getCharacterId())).getTexts());
    if(name!=null&&Arrays.asList("mapdisplay","ground","mapscene","shirt","hat","gundisplay","perkdisplay","modedisplay").contains(name)) {
      CharacterTag target=swf.getCharacter(p.getCharacterId());
      System.out.println("INSTANCE "+parent+" frame "+frame+" "+name+" -> "+p.getCharacterId()+" frames="+(target instanceof DefineSpriteTag?((DefineSpriteTag)target).frameCount:"none"));
    }
   }
   if(t instanceof DefineSpriteTag) inspect(((DefineSpriteTag)t).getTags(),"sprite"+((DefineSpriteTag)t).spriteId);
   if(t instanceof TextTag) System.out.println("TEXT "+((TextTag)t).getCharacterId()+" "+String.join("",((TextTag)t).getTexts()).replace('\n',' '));
  }
 }
 public static void main(String[] args)throws Exception {swf=new SWF(new FileInputStream(args[0]),false);inspect(swf.getTags(),"root");System.exit(0);}
}
