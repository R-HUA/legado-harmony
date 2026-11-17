/** R-HUA/legado-harmony 本地发行版特性开关；与上游不同的产品决策都集中在这里。 */
export class LocalBuildFeatures {
  /** 眼动翻页依赖相机和闭源人脸关键点模型，本地发行版不提供：入口隐藏，运行路径截断。 */
  static readonly EYE_TURN: boolean = false;
  /** 网页解析（书源）始终开启，不设开关和使用须知（见 WebParseSettingsStore）。 */
  static readonly WEB_PARSE_ALWAYS_ON: boolean = true;
}
