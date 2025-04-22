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
}


export interface SessionData {
  userdata: UserData
  config: Config
}

