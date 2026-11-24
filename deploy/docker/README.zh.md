# DSH Web 容器部署

[English](README.md) | 中文

这套部署将源码构建的 DSH Web 插件家族与官方 DeepSeek Harness 运行环境打包，包含运维工作台。镜像面向 Linux amd64，固定使用 Node 24.22.3 和 DSH 0.2.2-rc.3，应用数据保存在镜像外。

## 能力

- 从源码构建全部工作区插件，生成独立的生产依赖目录，共享一套官方宿主 SDK。
- 通过经过认证的同源容器入口提供网页界面、SSH 服务器仓库和运维工作台。
- 会话、模型设置、SSH 配置和运维记录持久化到 `/data`，项目文件持久化到 `/workspace`。
- 更新已有受管容器时保留两个持久化目录，替换实例启动检查失败时重新启动上一个容器。

## 安装

将 `install.sh` 放到 Linux amd64 服务器。私有交付包还可以在同目录放置 `registry.credentials`，使用字面键 `REGISTRY`、`USERNAME` 和 `PASSWORD`。安装器将这些值作为数据读取，并通过 Docker 标准输入提交密码。

```sh
bash install.sh --public-url http://192.168.1.20:3080
```

安装器使用已有 Docker 引擎，或通过 Docker 官方安装脚本安装 Docker。随后拉取 `crpi-n1l0skbmprpjqh57.cn-shenzhen.personal.cr.aliyuncs.com/cj-aiops-platform/dsh-web:latest`，启动容器，并输出包含当前登录 token 的浏览器地址。首次访问请使用完整地址。

再次执行同一命令即可更新。首次安装默认使用 `$HOME/dsh-web` 下独立的 `data` 和 `workspace` 目录，运行用户为调用者的数字 UID 和 GID。更新时沿用受管容器已有的绑定目录和运行用户，即使通过 sudo 重跑或主目录发生变化也会保留。显式指定的 `--data-dir`、`--workspace-dir`、`DSH_DATA_DIR` 或 `DSH_WORKSPACE_DIR` 会覆盖对应目录。

## 配置

`bash install.sh --help` 列出全部支持选项。`--image` 可以指定固定版本标签，`--data-dir` 和 `--workspace-dir` 可以沿用已有目录，`--port` 可以修改发布端口。`--public-url` 是浏览器访问的准确来源地址，使用非默认端口时需要包含端口。反向代理可以终止 HTTPS，并在保留公开 Host 和 Origin 的情况下转发到发布端口。

仓库登录信息也可以通过 `DSH_REGISTRY_USER` 和 `DSH_REGISTRY_PASSWORD` 提供。已有 Docker 登录和匹配凭据文件均不可用时，安装器会私密提示输入。`--credentials-file` 选择其他字面凭据文件，`--skip-login` 要求使用已有 Docker 凭据。

登录后在应用中配置模型提供方和 SSH 主机。模型请求发送到配置的提供方。模型服务位于内网时，请设置内网模型接口。初始 profile 启用 SSH 和运维工作台，后续 profile 设置在替换容器时保留。

```sh
docker logs --tail 100 dsh-web
docker exec dsh-web cat /data/.browser-entry
docker stop --time 30 dsh-web
docker start dsh-web
```

## 构建

在仓库根目录使用干净的源码上下文构建。运行凭据保存在持久化数据目录或私有交付包中，Docker 忽略规则会排除凭据文件和本地依赖目录。

```sh
docker buildx build --platform linux/amd64 \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --tag crpi-n1l0skbmprpjqh57.cn-shenzhen.personal.cr.aliyuncs.com/cj-aiops-platform/dsh-web:latest \
  --load .
```

Docker 构建在 BuildKit 本机平台上使用同版本官方 SDK 编译工作区。编译前删除已有包产物，仅传递经验证可移植的 `packages/*/lib` 输出，包含声明文件、复制的浏览器资源和 shell 元数据。独立目标平台阶段按锁文件安装生产依赖，生成生产依赖闭包，并将共享 SDK 引用指向该阶段的官方运行环境安装目录。构建平台的依赖树不会进入运行镜像。镜像包含聚合包声明的已发布卫星依赖，以及它们匹配目标平台的原生依赖。

## 安全模型

公开入口接受配置的 Host 和匹配的浏览器 Origin。原生 DSH 启动 token 用于换取官方签名的浏览器所有者 cookie。后续每个 HTTP 请求和 WebSocket 升级都会先通过 DSH 验证该 cookie，再由代理转发到只监听回环的后端。代理将已验证的请求转换为内部来源地址。SSH 和运维插件的访问围栏持续生效。

后端只监听容器回环端口 3080，Docker 发布容器内部端口 8080 上的代理。容器健康检查验证网页入口、空的插件降级账本、运维树和 SSH 主机仓库，安装器随后才报告成功。默认启动环境关闭官方会话遥测和会话日志上传。社区插件家族的浏览器遥测偏好位于“设置、Web 插件、匿名安装遥测”。

## 已知限制

- 初始模型提供方和 SSH 凭据在部署后配置，保存在 `/data`。
- 原生浏览器自动化和外部集成需要各自的依赖与服务配置。
- 公开访问使用一个配置的浏览器来源地址，迁移到其他地址时需要修改 `--public-url`。
- 容器回滚沿用同一组持久化目录，应用数据及独立备份由运维方维护。
