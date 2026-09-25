"""
python -m splatpyr <command> ...

  ingest IMAGE OUT            cut the image into the pixel pyramid
  build OUT                   splats for the coarse levels, JPEG tiles below (--split)
  serve OUT                   viewer + units, fitting missing units on demand
  bench-unit OUT L X Y        one unit at several targets, against JPEG
  bench-hierarchy OUT L X Y   residual on coarser levels vs from scratch: GO / NO-GO
  check OUT L                 what the viewer shows at level L vs the pixels, seams included

Fitting settings (--psnr, --max-blobs, --polish, ...) given to ingest or build are saved in
OUT/fit.json and used by every later command, the server's on-demand fits included.
"""

import argparse
import os
import sys
from dataclasses import fields

from .build import build, load_config, save_config
from .fit import FitConfig


def _fit_options(ap):
    g = ap.add_argument_group("fitting (saved to OUT/fit.json)")
    g.add_argument("--psnr", type=float, help="target PSNR per unit (default 32)")
    g.add_argument("--max-blobs", type=int, help="blob cap per full tile (default 6000)")
    g.add_argument("--polish", type=int, help="Adam steps after the formula, 0 = none (default 300)")
    g.add_argument("--margin", type=int, help="neighbour pixels the fit also looks at (default 8)")


def _apply_fit_options(root, args):
    cfg = load_config(root)
    names = {f.name for f in fields(FitConfig)}
    changed = False
    for key in ("psnr", "max_blobs", "polish", "margin"):
        value = getattr(args, key, None)
        if value is not None and key in names:
            setattr(cfg, key, value)
            changed = True
    if changed or not _has_config(root):
        save_config(root, cfg)
    return cfg


def _has_config(root):
    return os.path.exists(os.path.join(root, "fit.json"))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="splatpyr", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ingest", help="cut an image into the pixel pyramid")
    p.add_argument("image")
    p.add_argument("out")
    p.add_argument("--tile", type=int, default=256)
    p.add_argument("--split", type=int, default=None,
                   help="first splat level; finer levels are written as JPEG tiles only "
                        "(default: at most --splat-units fitted units)")
    p.add_argument("--splat-units", type=int, default=300)
    p.add_argument("--tile-format", choices=["auto", "jpg", "webp"], default="auto",
                   help="tiles below the split: auto keeps lossless WebP per tile when it is "
                        "at most 1.5x the JPEG (exact text and graphics), else JPEG")
    p.add_argument("--engine", choices=["vips", "pil"], default=None,
                   help="vips streams any size (default when pyvips is installed); "
                        "pil holds a level in memory")
    _fit_options(p)

    p = sub.add_parser("build", help="fit splats, coarsest level first")
    p.add_argument("out")
    p.add_argument("--finest", type=int, default=0,
                   help="stop at this level; finer ones are fitted on demand by serve")
    p.add_argument("--workers", type=int, default=None)
    p.add_argument("--split", type=int, default=None,
                   help="first splat level; finer levels become JPEG tiles "
                        "(default: the split chosen at ingest)")
    p.add_argument("--splat-units", type=int, default=300,
                   help="budget of fitted units, for images ingested before splits existed")
    _fit_options(p)

    p = sub.add_parser("serve", help="viewer and units, fitting on demand")
    p.add_argument("out")
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--no-lazy", action="store_true", help="serve only units already fitted")

    p = sub.add_parser("bench-unit", help="one unit at several targets, against JPEG")
    p.add_argument("out")
    p.add_argument("level", type=int)
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p.add_argument("--targets", default="28,30,32,34,36")

    p = sub.add_parser("bench-hierarchy", help="residual vs from scratch: GO / NO-GO")
    p.add_argument("out")
    p.add_argument("level", type=int)
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p.add_argument("--psnr", type=float, default=32.0)

    p = sub.add_parser("check", help="viewer output at a level vs the pixels")
    p.add_argument("out")
    p.add_argument("level", type=int)
    p.add_argument("--sample", type=int, default=16, help="units to check, 0 = all")
    p.add_argument("--png", help="also write the whole level, splats beside pixels")

    args = ap.parse_args(argv)

    if args.cmd == "ingest":
        from .pyramid import ingest
        ingest(args.image, args.out, args.tile, split=args.split,
               splat_units=args.splat_units, engine=args.engine, tile_format=args.tile_format)
        _apply_fit_options(args.out, args)
    elif args.cmd == "build":
        _apply_fit_options(args.out, args)
        build(args.out, finest=args.finest, workers=args.workers, split=args.split,
              splat_units=args.splat_units)
    elif args.cmd == "serve":
        from .serve import serve
        serve(args.out, args.port, lazy=not args.no_lazy)
    elif args.cmd == "bench-unit":
        from .bench import bench_unit
        bench_unit(args.out, args.level, args.x, args.y,
                   [float(t) for t in args.targets.split(",")])
    elif args.cmd == "bench-hierarchy":
        from .bench import bench_hierarchy
        bench_hierarchy(args.out, args.level, args.x, args.y, args.psnr)
    elif args.cmd == "check":
        from .bench import check
        check(args.out, args.level, args.sample, png=args.png)
    return 0


if __name__ == "__main__":
    sys.exit(main())
