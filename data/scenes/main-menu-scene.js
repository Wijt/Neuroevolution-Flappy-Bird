class MainMenuScene extends Scene {
    constructor() {
        super();

        this.playButton;
        this.trainButton;
        this.watchButton;
    }

    start() {
        super.start();

        this.playButton = createButton('play');
        this.playButton.addClass("main-menu-button");
        this.playButton.size("15rem", "5rem");
        // this couldn't be done with css because of the p5.js cannot detect the size of the button when positioning it
        this.playButton.position(innerWidth/2-this.playButton.width/2, innerHeight/2);
        this.playButton.mouseClicked(() => {
            this.sceneManager.openScene(PLAY_SCENE);
        });

        this.trainButton = createButton('train');
        this.trainButton.addClass("main-menu-button");
        this.trainButton.size("15rem", "5rem");
        this.trainButton.position(innerWidth/2 - this.trainButton.width/2, innerHeight/2 + this.playButton.height + 25);
        this.trainButton.mouseClicked(() => {
            this.sceneManager.openScene(TRAIN_SCENE);
        });

        this.watchButton = createButton('watch');
        this.watchButton.addClass("main-menu-button");
        this.watchButton.size("15rem", "5rem"); 
        this.watchButton.position(innerWidth/2- this.watchButton.width/2, innerHeight/2 + (this.playButton.height + this.trainButton.height + 50));
        this.watchButton.mouseClicked(() => {
            this.sceneManager.openScene(WATCH_SCENE);
        });
    }

    update() {
        super.update();
    }

    draw() {      
        background(color(PIPE_COLOR));
        
        stroke(8);
        fill(255);
        textSize(80);
        textAlign(CENTER, CENTER);
        text("Genius Bird", width/2, height/2 - 200);
    }

    exit() {
        super.exit();
        this.playButton.remove();
        this.trainButton.remove();
        this.watchButton.remove();
    }

}