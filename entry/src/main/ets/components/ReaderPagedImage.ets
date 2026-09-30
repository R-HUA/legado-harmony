import image from '@ohos.multimedia.image';
import { ReaderPagedImageCache, ReaderPagedImageLease } from '../core/reader/ReaderPagedImageCache';

@Component
export struct ReaderPagedImage {
  uri: string = '';
  widthPx: number = 1;
  heightPx: number = 1;
  heightVp: number = 120;
  hintColor: string = '#202124';
  onSettled: () => void = () => {};
  @State private pixelMap: image.PixelMap | null = null;
  @State private fallback: boolean = false;
  @State private broken: boolean = false;
  private lease: ReaderPagedImageLease | null = null;
  private alive: boolean = false;

  aboutToAppear(): void {
    this.alive = true;
    const lease = ReaderPagedImageCache.acquire(this.uri, this.widthPx, this.heightPx);
    this.lease = lease;
    this.pixelMap = lease.value;
    lease.ready.then((pixelMap: image.PixelMap | null) => {
      if (!this.alive || this.lease !== lease) return;
      this.pixelMap = pixelMap;
      this.fallback = !pixelMap;
    });
  }

  aboutToDisappear(): void {
    this.alive = false;
    this.lease?.release();
    this.lease = null;
  }

  build() {
    Stack() {
      if (this.pixelMap) {
        // Network fetch and decoding have already finished asynchronously. Only bind the shared pixels here.
        Image(this.pixelMap)
          .syncLoad(true)
          .width('100%')
          .height(this.heightVp)
          .objectFit(ImageFit.Contain)
          .draggable(false)
          .onComplete((event) => {
            if (event?.loadingStatus === 1) this.onSettled();
          })
          .onError(() => {
            this.broken = true;
            this.onSettled();
          })
      } else if (this.fallback) {
        Image(this.uri)
          .syncLoad(false)
          .width('100%')
          .height(this.heightVp)
          .objectFit(ImageFit.Contain)
          .draggable(false)
          .onComplete((event) => {
            if (event?.loadingStatus === 1) this.onSettled();
          })
          .onError(() => {
            this.broken = true;
            this.onSettled();
          })
      } else {
        LoadingProgress().width(28).height(28).color(this.hintColor).opacity(0.5)
      }
      if (this.broken) {
        Text('图片加载失败').fontColor(this.hintColor).opacity(0.6)
      }
    }
    .width('100%')
    .height(this.heightVp)
    .clip(true)
  }
}
