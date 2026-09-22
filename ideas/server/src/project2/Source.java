package project2;

/**
 * Where tiles come from.
 *
 * Two implementations: {@link ImageStore} decodes the image into memory and renders tiles
 * on demand (fine for ordinary photos), and {@link TiledStore} reads tiles that Ingest
 * already wrote to disk (the only option at gigapixel scale, where the image cannot be
 * held in memory at all).
 *
 * Session talks to this interface and neither knows nor cares which it got.
 */
public interface Source {

    int width();
    int height();
    int tileSize();
    double ratio();
    int maxLevel();

    /** Source pixels per tile pixel at this ladder level. */
    double ladderScale(int level);

    int levelWidth(int level);
    int levelHeight(int level);

    /** JPEG bytes for one tile, or null if the tile is outside the image. */
    byte[] tile(int level, int tx, int ty) throws Exception;
}
