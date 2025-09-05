export interface UserData {
  confessionTime: number,
  confessions: Array<
    {
      id: number
    }
  >
  isBanned: boolean
  freeConfessions: number
  refby: number

}
export interface Config {
  isLogged: boolean,
  threadId?: number,
  nextLogTryAt?: number,
}


export interface SessionData {
  userdata: UserData
  config: Config
}
