_root.__netOriginalEnterFrame = _root.onEnterFrame;
_root.onEnterFrame = function()
{
   _root.__netTicks += 1;
   _root.__netOriginalEnterFrame();
};
